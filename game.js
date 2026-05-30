/**
 * Geopolitics - Main Engine
 */

import { formatNum, getFuzzy, getCentroid, snapToCoast } from './utils.js';

let world;
let mapData = [];
let originalMapData = [];

// Game State
let player = { active: false, empireName: '', stats: { pop: 0, mil: 0 } };
let activeMode = 'takeover'; 
let hoverCountry = null;
let drawnPoints = [];
let isDrawing = false;
let isPaused = false;
let hasUnsavedChanges = false;
let aiInterval = null;
let activeArcs = [];
let activeRings = [];
let explosionData = []; 
let invasionProgress = {}; 
let resolution = localStorage.getItem('geo_res') || 'high';
let currentGameId = null;

// IndexedDB Setup
const DB_NAME = 'GeoDB_v3'; // Incremented for schema changes
const STORE_NAME = 'games';
const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

// Colors
const PLAYER_COLOR = '#0070f3';
const COLORS = {
    1: '#ff4d4d', 2: '#7928ca', 3: '#00dfd8', 4: '#ffca28', 
    5: '#9b59b6', 6: '#ff0080', 7: '#50e3c2'
};

function getCountryColor(feature) {
    if (!feature || !feature.properties) return '#fff';
    if (feature.properties.owner === player.empireName) return PLAYER_COLOR;
    const mc = feature.properties.MAPCOLOR7;
    let color = COLORS[mc] || `hsl(${Math.abs(feature.properties.ADMIN.charCodeAt(0) * 20) % 360}, 70%, 50%)`;
    if (color === PLAYER_COLOR) color = '#f5a623'; 
    return color;
}

function getOwnerColor(ownerName) {
    if (ownerName === player.empireName) return PLAYER_COLOR;
    const ownerNode = mapData.find(f => f.properties.ADMIN === ownerName);
    return ownerNode ? getCountryColor(ownerNode) : '#fff';
}

const GEO_URL = './map.geojson';

// Expose globals
window.initializeGame = () => {
    if (window.deploymentPending) startDeployment();
    else logMsg("Initializing engine...");
};
window.handleAction = executeAction;
window.saveGame = saveCampaign;
window.locateNation = locateAndPulse;
window.pauseAndSave = pauseAndSaveGame;
window.exitToMenu = exitToMenuFlow;
window.showSettings = () => { document.getElementById('settings-overlay').style.display = 'flex'; };
window.hideSettings = () => { document.getElementById('settings-overlay').style.display = 'none'; };
window.setResolution = (res) => {
    resolution = res;
    localStorage.setItem('geo_res', res);
    document.getElementById('res-high').classList.toggle('active', res === 'high');
    document.getElementById('res-low').classList.toggle('active', res === 'low');
    if (res === 'low') {
        activeArcs = []; explosionData = [];
        world.arcsData([]); world.customLayerData([]);
    } else {
        world.arcsData(activeArcs); world.customLayerData(explosionData);
    }
};

// Builder Globals
window.togglePenTool = () => {
    isDrawing = !isDrawing;
    document.getElementById('pen-controls').style.display = isDrawing ? 'flex' : 'none';
    if (!isDrawing) { 
        drawnPoints = []; 
        world.pathsData([]); 
        world.pointsData([]);
        world.polygonsData(mapData);
    }
    logMsg(isDrawing ? "Pen Active: Click vertices (Shift to Snap)" : "Pen Suspended");
};
window.autoCoastFix = () => {
    if (drawnPoints.length < 2) return;
    const coastlines = { type: 'FeatureCollection', features: originalMapData };
    drawnPoints = drawnPoints.map(p => {
        const point = { type: 'Point', coordinates: p };
        return snapToCoast(point, coastlines, 2.0); 
    });
    // Update visuals
    world.pathsData([{ coords: drawnPoints.map(p => [p[1], p[0]]) }]);
    world.pointsData(drawnPoints.map(p => ({ lat: p[1], lng: p[0] })));
    
    // Update Preview
    if (drawnPoints.length > 2) {
        const preview = {
            type: 'Feature',
            properties: { isPreview: true },
            geometry: { type: 'Polygon', coordinates: [[...drawnPoints, drawnPoints[0]]] }
        };
        const rewound = turf.rewind(preview, { reverse: true });
        world.polygonsData([...mapData, rewound]);
    }
    logMsg("Auto-Coast Optimization Complete");
};
window.finalizeCustom = () => {
    if (drawnPoints.length < 3) return logMsg("Min 3 nodes required");
    const name = prompt("Empire Designation:");
    if (!name) return;
    let feat = {
        type: 'Feature',
        properties: { ADMIN: name, owner: name, MAPCOLOR7: Math.floor(Math.random()*7)+1, gameStats: { pop: 10000000, mil: 100000 } },
        geometry: { type: 'Polygon', coordinates: [[...drawnPoints, drawnPoints[0]]] }
    };
    feat = turf.rewind(feat, { reverse: true }); // FIX: Ensure inside fill
    mapData.push(feat);
    setupNeighborhoods();
    world.polygonsData(mapData);
    drawnPoints = []; world.pathsData([]); world.pointsData([]);
    logMsg(`Nation Established: ${name}`);
};
window.clearPen = () => { 
    drawnPoints = []; 
    world.pathsData([]); 
    world.pointsData([]);
    world.polygonsData(mapData);
};
window.useNormalBorders = (adminName) => {
    const original = originalMapData.find(f => f.properties.ADMIN === adminName);
    if (!original) return;
    const feat = JSON.parse(JSON.stringify(original));
    feat.properties.owner = adminName;
    mapData = mapData.filter(f => f.properties.ADMIN !== adminName);
    mapData.push(feat);
    setupNeighborhoods();
    world.polygonsData(mapData);
    logMsg(`Imported Borders: ${adminName}`);
};

// Management Globals
window.deleteGame = deleteGame;
window.renameGame = renameGame;
window.exportAllSaves = exportSaves;
window.triggerImport = () => document.getElementById('import-file').click();
window.importSave = importSave;

// Initialize
async function init() {
    try {
        const res = await fetch(GEO_URL);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const data = await res.json();
        
        originalMapData = data.features.map(f => {
            const p = f.properties;
            const pop = p.POP_EST || 1000000;
            f.properties.owner = p.ADMIN;
            f.properties.gameStats = { pop: pop, mil: Math.floor(pop * 0.01) };
            return f;
        });

        resetMapData();
        setupNeighborhoods();
        setupWorld();
        setupUIEvents();
        loadGamesFromDB();
        
        window.deploymentPending = true;
        window.setResolution(resolution);
    } catch (err) {
        console.error("Engine Fault:", err);
        logMsg("Data link failure");
    }
}

function resetMapData() {
    mapData = []; // Start empty for Builder, but game tick will handle others
}

function setupNeighborhoods() {
    // Only original/custom features in mapData
    mapData.forEach(c1 => {
        c1.properties.neighbors = [];
        const cent1 = getCentroid(c1);
        mapData.forEach(c2 => {
            if (c1 === c2) return;
            const cent2 = getCentroid(c2);
            const dist = Math.sqrt(Math.pow(cent1[0] - cent2[0], 2) + Math.pow(cent1[1] - cent2[1], 2));
            if (dist < 80) c1.properties.neighbors.push(c2.properties.ADMIN);
        });
    });
}

function setupWorld() {
    // Attempt to resolve THREE from various global signatures
    const _THREE = window.THREE || (window.Globe ? window.Globe.THREE : null);
    
    world = Globe()(document.getElementById('globe-container'))
        .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
        .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
        .backgroundColor('#000000')
        .showAtmosphere(true)
        .atmosphereColor('#ffffff')
        .atmosphereAltitude(0.12)
        .polygonsData(mapData)
        .polygonCapColor(d => {
            if (d.properties.isPreview) return 'rgba(255, 255, 0, 0.4)';
            if (activeMode === 'builder' && d.properties.owner === player.empireName) return PLAYER_COLOR + 'aa';
            const ownerColor = getOwnerColor(d.properties.owner);
            const progs = invasionProgress[d.properties.ADMIN];
            if (progs && progs.length > 0) {
                const primary = progs.sort((a,b) => b.val - a.val)[0];
                return `rgba(${hexToRgb(getOwnerColor(primary.attacker))}, ${primary.val})`;
            }
            if (hoverCountry === d) return ownerColor + 'cc';
            return ownerColor;
        })
        .polygonSideColor(() => 'rgba(255,255,255,0.05)')
        .polygonStrokeColor(d => activeMode === 'builder' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.3)')
        .polygonAltitude(0.01)
        .polygonLabel(d => createTooltip(d))
        .onPolygonHover(d => {
            hoverCountry = d;
            if (world) world.polygonCapColor(world.polygonCapColor());
        })
        .onPolygonClick((d, e) => handlePolygonClick(d, e))
        .onPolygonRightClick((d, e) => showCtxMenu(d, e))
        .customLayerData(explosionData)
        .customThreeObject(d => {
            if (!_THREE) return null;
            const group = new _THREE.Group();
            const mat = new _THREE.MeshLambertMaterial({ color: 0xff4d4d, transparent: true, opacity: 0.8 });
            const sphere = new _THREE.Mesh(new _THREE.SphereGeometry(1, 16, 16), mat);
            sphere.position.y = 0.5;
            group.add(sphere);
            return group;
        })
        .customThreeObjectUpdate((obj, d) => {
            const scale = d.radius * (1 - d.age);
            obj.scale.set(scale, scale, scale);
            if (obj.children[0]) obj.children[0].material.opacity = 1 - d.age;
        });

    world.controls().autoRotate = true;
    world.controls().autoRotateSpeed = 0.3;
    world.pointOfView({ lat: 20, lng: 0, altitude: 2.5 });

    // Builder click handling
    world.onGlobeClick((coords, event) => {
        if (activeMode !== 'builder' || !player.active || !isDrawing) return;
        let point = [coords.lng, coords.lat];
        
        // AUTO-SNAP: Shift connects last point to first to close polygon
        if (event.shiftKey && drawnPoints.length > 2) {
            point = [...drawnPoints[0]];
            logMsg("Polygon Loop Closed");
        }
        
        drawnPoints.push(point);
        
        // Render Yellow Path
        world.pathColor(() => '#ffff00')
             .pathStroke(2)
             .pathsData([{ coords: drawnPoints.map(p => [p[1], p[0]]) }]);
        
        // Show points (vertices)
        world.pointColor(() => '#ffffff')
             .pointRadius(0.2)
             .pointsData(drawnPoints.map(p => ({ lat: p[1], lng: p[0] })));

        // NEW: Filled Preview
        if (drawnPoints.length > 2) {
            try {
                const preview = {
                    type: 'Feature',
                    properties: { isPreview: true },
                    geometry: { type: 'Polygon', coordinates: [[...drawnPoints, drawnPoints[0]]] }
                };
                const rewound = turf.rewind(preview, { reverse: true });
                if (rewound && rewound.geometry) {
                    world.polygonsData([...mapData, rewound]);
                }
            } catch (e) {
                console.warn("Preview geometry invalid", e);
            }
        }

        hasUnsavedChanges = true;
    });
}

function setupUIEvents() {
    document.querySelectorAll('.mode-card').forEach(card => {
        card.addEventListener('click', (e) => {
            document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('active'));
            e.currentTarget.classList.add('active');
            activeMode = e.currentTarget.getAttribute('data-mode');
        });
    });

    const searchInput = document.getElementById('start-country');
    const sidebarSearch = document.getElementById('sidebar-country-search');
    
    [searchInput, sidebarSearch].forEach(input => {
        if (!input) return;
        input.addEventListener('input', (e) => {
            const val = e.target.value.toLowerCase();
            const resultsDiv = input.id === 'start-country' ? document.getElementById('search-results') : null;
            
            const matches = originalMapData.filter(f => 
                f.properties.ADMIN.toLowerCase().includes(val) || 
                (f.properties.ADM0_A3 && f.properties.ADM0_A3.toLowerCase().includes(val))
            ).slice(0, input.id === 'start-country' ? 8 : 50);

            if (input.id === 'start-country') {
                if (!val) { resultsDiv.style.display = 'none'; return; }
                resultsDiv.innerHTML = matches.map(m => `<div class="search-item">${m.properties.ADMIN}</div>`).join('');
                resultsDiv.style.display = 'block';
                document.querySelectorAll('.search-item').forEach(item => {
                    item.addEventListener('click', (ev) => {
                        searchInput.value = ev.target.innerText;
                        resultsDiv.style.display = 'none';
                    });
                });
            } else {
                updateSidebarList(matches);
            }
        });
    });
}

function updateSidebarList(matches) {
    const list = document.getElementById('sidebar-nation-list');
    list.innerHTML = matches.map(m => `
        <div class="sidebar-nation-item" onclick="window.useNormalBorders('${m.properties.ADMIN}')">
            ${m.properties.ADMIN.toUpperCase()}
        </div>
    `).join('');
}

function startDeployment() {
    const query = document.getElementById('start-country').value.trim().toLowerCase();
    const startNode = originalMapData.find(f => f.properties.ADMIN.toLowerCase() === query);
    if (!startNode) return alert("Nation Unknown.");

    player.active = true;
    player.empireName = startNode.properties.ADMIN;
    currentGameId = currentGameId || Date.now();
    
    // In builder, start with only chosen nation
    if (activeMode === 'builder') {
        mapData = [JSON.parse(JSON.stringify(startNode))];
        mapData[0].properties.owner = player.empireName;
        document.getElementById('builder-sidebar').style.display = 'flex';
        updateSidebarList(originalMapData.slice(0, 50));
    } else {
        mapData = JSON.parse(JSON.stringify(originalMapData));
    }

    setupNeighborhoods();
    document.getElementById('setup-screen').style.display = 'none';
    document.getElementById('status-bar').style.display = 'flex';
    document.getElementById('leaderboard').style.display = 'flex';
    document.getElementById('controls').style.display = 'flex';
    
    world.controls().autoRotate = false;
    const centroid = getCentroid(startNode);
    world.pointOfView({ lat: centroid[1], lng: centroid[0], altitude: 1.2 }, 2000);

    updateUI(); updateLeaderboard();
    logMsg(`DEPLOYMENT: ${startNode.properties.ADMIN}`);
    if (activeMode !== 'builder') {
        if (aiInterval) clearInterval(aiInterval);
        aiInterval = setInterval(gameTick, 2000);
    }
}

function locateAndPulse(adminName) {
    const target = mapData.find(f => f.properties.ADMIN === adminName);
    if (!target) return;
    const centroid = getCentroid(target);
    world.pointOfView({ lat: centroid[1], lng: centroid[0], altitude: 1.2 }, 1200);
    activeRings.push({ lat: centroid[1], lng: centroid[0], maxR: 20, speed: 4, repeat: 0, color: PLAYER_COLOR });
    world.ringsData(activeRings);
    setTimeout(() => { activeRings = []; world.ringsData([]); }, 1500);
}

function updateUI() {
    if (!player.active) return;
    const playerLands = mapData.filter(f => f.properties.owner === player.empireName);
    player.stats.pop = playerLands.reduce((sum, f) => sum + f.properties.gameStats.pop, 0);
    player.stats.mil = playerLands.reduce((sum, f) => sum + f.properties.gameStats.mil, 0);
    const vEmpire = document.getElementById('val-empire');
    const vTerr = document.getElementById('val-terr');
    const vMil = document.getElementById('val-mil');
    if (vEmpire) vEmpire.innerText = player.empireName;
    if (vTerr) vTerr.innerText = playerLands.length;
    if (vMil) vMil.innerText = formatNum(player.stats.mil);
    world.polygonsData(mapData);
}

function updateLeaderboard() {
    if (activeMode === 'builder') {
        const lb = document.getElementById('leaderboard');
        if (lb) lb.style.display = 'none';
        return;
    }
    const lbList = document.getElementById('lb-list');
    if (!lbList) return;
    let scores = {};
    mapData.forEach(f => {
        const owner = f.properties.owner;
        if(!scores[owner]) scores[owner] = { terr: 0, mil: 0 };
        scores[owner].terr++;
        scores[owner].mil += f.properties.gameStats.mil;
    });
    const sorted = Object.entries(scores).sort((a,b) => b[1].terr - a[1].terr).slice(0, 20);
    lbList.innerHTML = sorted.map((entry, idx) => `
        <div class="lb-item ${entry[0] === player.empireName ? 'player' : ''}" onclick="window.locateNation('${entry[0]}')">
            <span class="lb-name">${idx + 1}. ${entry[0]}</span>
            <span class="lb-val">${entry[1].terr}<span class="lb-sub">S</span> / ${formatNum(entry[1].mil)}<span class="lb-sub">M</span></span>
        </div>
    `).join('');
}

function logMsg(msg) {
    const log = document.getElementById('combat-log');
    if (log) log.innerText = msg.toUpperCase();
}

function createTooltip(d) {
    if (!player.active) return '';
    const p = d.properties;
    if (p.isPreview) return '<div class="tactical-tooltip">PREVIEW SECTOR</div>';
    
    const stats = p.gameStats || { pop: 0, mil: 0 };
    const ownerColor = getOwnerColor(p.owner);
    return `
        <div class="tactical-tooltip">
            <div style="font-weight:700; border-bottom:1px solid #333; padding-bottom:6px; margin-bottom:6px; display:flex; justify-content:space-between;">
                ${p.ADMIN || 'Unknown'} <span style="color:${ownerColor}; font-size:0.6rem; font-weight:800;">${p.owner || 'Neutral'}</span>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:0.65rem; color:#888;">
                <span>Personnel</span> <span style="color:#fff;">${formatNum(stats.pop)}</span>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:0.65rem; color:#888;">
                <span>Military</span> <span style="color:#fff;">${formatNum(stats.mil)}</span>
            </div>
        </div>
    `;
}

function handlePolygonClick(d, e) {
    if (!player.active || activeMode === 'builder' || isPaused) return;
    if (d.properties.owner === player.empireName) return;
    const playerLands = mapData.filter(f => f.properties.owner === player.empireName);
    const isBordering = playerLands.some(land => land.properties.neighbors.includes(d.properties.ADMIN));
    executeInvasion(player.empireName, d, isBordering ? 'border' : 'air');
    hasUnsavedChanges = true;
}

function showCtxMenu(d, e) {
    if (!player.active || activeMode === 'builder' || isPaused) return;
    if (d.properties.owner === player.empireName) return;
    const menu = document.getElementById('ctx-menu');
    if (menu) {
        menu.style.display = 'block';
        menu.style.left = `${e.clientX}px`; menu.style.top = `${e.clientY}px`;
        window.lastCtxTarget = d;
    }
}

function executeAction(type) {
    const target = window.lastCtxTarget;
    if (document.getElementById('ctx-menu')) document.getElementById('ctx-menu').style.display = 'none';
    if (!target) return;
    if (type === 'invade') handlePolygonClick(target);
    if (type === 'nuke') { launchStrike(player.empireName, target); hasUnsavedChanges = true; }
}

function executeInvasion(attackerName, targetFeature, type = 'border') {
    const targetName = targetFeature.properties.ADMIN;
    if (!invasionProgress[targetName]) invasionProgress[targetName] = [];
    if (invasionProgress[targetName].some(p => p.attacker === attackerName)) return;

    const attackerLands = mapData.filter(f => f.properties.owner === attackerName);
    if (attackerLands.length === 0) return;

    let attMil = attackerLands.reduce((sum, f) => sum + f.properties.gameStats.mil, 0);
    let defMil = targetFeature.properties.gameStats.mil;
    
    const threshold = type === 'air' ? 4.0 : 2.5;
    if (defMil > attMil * threshold) {
        if (attackerName === player.empireName) logMsg(`${type.toUpperCase()} ASSAULT IMPOSSIBLE: ${targetName}`);
        return;
    }

    const tCentroid = getCentroid(targetFeature);
    const sCentroid = getCentroid(attackerLands[0]); 
    const arc = {
        startLat: sCentroid[1], startLng: sCentroid[0],
        endLat: tCentroid[1], endLng: tCentroid[0],
        color: type === 'air' ? ['#ffffff', '#ffffff'] : [getOwnerColor(attackerName), '#ffffff']
    };
    
    if (resolution === 'high') { activeArcs.push(arc); world.arcsData(activeArcs); }

    const progState = { active: true, val: 0, attacker: attackerName, startTime: Date.now() };
    invasionProgress[targetName].push(progState);
    const duration = (type === 'air' ? 4000 : 2000) + (defMil / 50000) * 1000;
    
    const anim = () => {
        if (isPaused) { progState.startTime += 16; requestAnimationFrame(anim); return; }
        const elapsed = Date.now() - progState.startTime;
        const prog = Math.min(1, elapsed / duration);
        progState.val = prog;
        if (world) world.polygonCapColor(world.polygonCapColor());
        if (prog < 1) requestAnimationFrame(anim);
        else {
            activeArcs = activeArcs.filter(a => a !== arc); world.arcsData(activeArcs);
            invasionProgress[targetName] = invasionProgress[targetName].filter(p => p !== progState);
            if (targetFeature.properties.owner === attackerName) return;
            if (attMil > defMil * 1.05) {
                targetFeature.properties.owner = attackerName;
                targetFeature.properties.gameStats.mil = Math.floor(attMil * 0.05);
                attackerLands.forEach(f => f.properties.gameStats.mil = Math.floor(f.properties.gameStats.mil * 0.9));
                if (attackerName === player.empireName) logMsg(`Annexation Complete: ${targetName}`);
            } else {
                attackerLands.forEach(f => f.properties.gameStats.mil = Math.floor(f.properties.gameStats.mil * 0.5));
                if (attackerName === player.empireName) logMsg(`Offensive Repelled: ${targetName}`);
            }
            updateUI(); updateLeaderboard();
        }
    };
    anim();
}

function launchStrike(attackerName, targetFeature) {
    const centroid = getCentroid(targetFeature);
    const attackerLands = mapData.filter(f => f.properties.owner === attackerName);
    if (attackerLands.length === 0) return;
    const startCentroid = getCentroid(attackerLands[0]);
    const arc = {
        startLat: startCentroid[1], startLng: startCentroid[0],
        endLat: centroid[1], endLng: centroid[0], color: ['#ffff00', '#ee0000'] 
    };
    if (resolution === 'high') { activeArcs.push(arc); world.arcsData(activeArcs); }
    setTimeout(() => {
        activeArcs = activeArcs.filter(a => a !== arc); world.arcsData(activeArcs);
        if (resolution === 'high') {
            const boom = { lat: centroid[1], lng: centroid[0], radius: 15, age: 0 };
            explosionData.push(boom);
            const boomAnim = () => {
                boom.age += 0.02;
                if (boom.age < 1) { world.customLayerData(explosionData); requestAnimationFrame(boomAnim); }
                else { explosionData = explosionData.filter(b => b !== boom); world.customLayerData(explosionData); }
            };
            boomAnim();
            document.body.classList.add('shake');
            activeRings.push({ lat: centroid[1], lng: centroid[0], maxR: 25, speed: 6, repeat: 0, color: '#ee0000' });
            world.ringsData(activeRings);
        }
        targetFeature.properties.gameStats.pop = Math.floor(targetFeature.properties.gameStats.pop * 0.1);
        targetFeature.properties.gameStats.mil = Math.floor(targetFeature.properties.gameStats.mil * 0.05);
        logMsg(`Impact Confirmed: ${targetFeature.properties.ADMIN}`);
        updateUI();
        setTimeout(() => { activeRings = []; world.ringsData([]); document.body.classList.remove('shake'); }, 1000);
    }, 1000);
}

function gameTick() {
    if (!player.active || isPaused) return;
    mapData.forEach(f => { f.properties.gameStats.mil += Math.floor(f.properties.gameStats.pop * 0.003); });
    const empiresList = [...new Set(mapData.map(f => f.properties.owner))];
    empiresList.forEach(emp => {
        if (emp === player.empireName) return;
        const myLands = mapData.filter(f => f.properties.owner === emp);
        if (myLands.length === 0) return;
        let potentialTargets = [];
        myLands.forEach(land => {
            land.properties.neighbors.forEach(nName => {
                const nNode = mapData.find(f => f.properties.ADMIN === nName);
                if (nNode && nNode.properties.owner !== emp) potentialTargets.push(nNode);
            });
        });
        if (potentialTargets.length === 0) return;
        let target = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
        if (activeMode === 'survival' && potentialTargets.some(t => t.properties.owner === player.empireName)) {
            target = potentialTargets.filter(t => t.properties.owner === player.empireName)[0];
        }
        const totalMil = myLands.reduce((sum, f) => sum + f.properties.gameStats.mil, 0);
        if (totalMil > target.properties.gameStats.mil * 1.5 && target.properties.gameStats.mil < totalMil * 0.6) executeInvasion(emp, target, 'border');
    });
    updateUI(); updateLeaderboard();
    if (mapData.filter(f => f.properties.owner === player.empireName).length === 0 && activeMode !== 'builder') {
        logMsg("Network Collapse: Domain Lost");
        player.active = false; clearInterval(aiInterval);
    }
}

async function pauseAndSaveGame() {
    isPaused = !isPaused;
    const overlay = document.getElementById('pause-overlay');
    if (isPaused) {
        if (overlay) overlay.style.display = 'flex';
        logMsg("System Static");
        await saveCampaign();
    } else {
        if (overlay) overlay.style.display = 'none';
        logMsg("System Active");
    }
}

async function saveCampaign() {
    const overlay = document.getElementById('saving-overlay');
    if (overlay) overlay.style.display = 'flex';
    const db = await dbPromise;
    const saveObj = {
        id: currentGameId, date: new Date().toLocaleString(), mode: activeMode, empire: player.empireName,
        mapState: mapData.map(f => ({ admin: f.properties.ADMIN, owner: f.properties.owner, stats: f.properties.gameStats, geom: f.geometry }))
    };
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(saveObj);
    tx.oncomplete = () => {
        setTimeout(() => { if (overlay) overlay.style.display = 'none'; logMsg("Backup Synced"); hasUnsavedChanges = false; loadGamesFromDB(); }, 800);
    };
}

async function loadGamesFromDB() {
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => {
        const list = document.getElementById('saves-list');
        if (!list) return;
        const saves = request.result.reverse();
        if (saves.length === 0) { list.innerHTML = '<div style="color: #444; font-size: 0.8rem;">No backups detected.</div>'; return; }
        list.innerHTML = saves.map(s => `
            <div class="save-item">
                <div class="save-info" onclick="window.restoreFromDB(${s.id})">
                    <div class="title">${s.empire.toUpperCase()}</div>
                    <div class="meta">${s.mode.toUpperCase()} • ${s.date}</div>
                </div>
                <div class="save-controls">
                    <button class="tiny-btn" onclick="window.renameGame(${s.id}, event)"><i class="fa-solid fa-pen"></i></button>
                    <button class="tiny-btn" style="color:var(--geist-error)" onclick="window.deleteGame(${s.id}, event)"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
        `).join('');
    };
}

async function deleteGame(id, e) {
    if (e) e.stopPropagation();
    if (!confirm("Permanently purge this campaign backup?")) return;
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => { logMsg("Sector Purged"); loadGamesFromDB(); };
}

async function renameGame(id, e) {
    if (e) e.stopPropagation();
    const newName = prompt("New Empire Designation:");
    if (!newName) return;
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => { const d = req.result; d.empire = newName; store.put(d); loadGamesFromDB(); };
}

async function exportSaves() {
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => {
        const blob = new Blob([JSON.stringify(request.result)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = `geopolitics_db_${Date.now()}.json`; a.click();
    };
}

function importSave(input) {
    const file = input.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);
            const db = await dbPromise;
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            (Array.isArray(data) ? data : [data]).forEach(g => store.put(g));
            tx.oncomplete = () => { logMsg("External Data Linked"); loadGamesFromDB(); };
        } catch (err) { alert("Invalid File"); }
    };
    reader.readAsText(file);
}

window.restoreFromDB = async (id) => {
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => {
        const save = request.result; if (!save) return;
        activeMode = save.mode; player.empireName = save.empire; currentGameId = save.id;
        mapData = save.mapState.map(s => ({
            type: 'Feature', properties: { ADMIN: s.admin, owner: s.owner, gameStats: s.stats },
            geometry: s.geom || originalMapData.find(f => f.properties.ADMIN === s.admin).geometry
        }));
        const searchInput = document.getElementById('start-country');
        if (searchInput) searchInput.value = player.empireName;
        startDeployment();
    };
};

function exitToMenuFlow() { if (hasUnsavedChanges) { if (!confirm("Purge unsaved tactical data?")) return; } location.reload(); }

init();
