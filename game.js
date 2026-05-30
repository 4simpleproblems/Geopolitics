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
let invasionProgress = {}; 

// IndexedDB Setup
const DB_NAME = 'GeoDB';
const STORE_NAME = 'saves';
const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
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
window.deploymentPending = false;

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
        loadSavesFromDB();
        
        window.deploymentPending = true;
    } catch (err) {
        console.error("Engine Fault:", err);
        logMsg("Data link failure");
    }
}

function resetMapData() {
    mapData = JSON.parse(JSON.stringify(originalMapData));
}

function setupNeighborhoods() {
    mapData.forEach(c1 => {
        c1.properties.neighbors = [];
        const cent1 = getCentroid(c1);
        mapData.forEach(c2 => {
            if (c1 === c2) return;
            const cent2 = getCentroid(c2);
            const dist = Math.sqrt(Math.pow(cent1[0] - cent2[0], 2) + Math.pow(cent1[1] - cent2[1], 2));
            if (dist < 25) c1.properties.neighbors.push(c2.properties.ADMIN);
        });
    });
}

function setupWorld() {
    world = Globe()(document.getElementById('globe-container'))
        .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
        .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
        .backgroundColor('#000000')
        .showAtmosphere(true)
        .atmosphereColor('#ffffff')
        .atmosphereAltitude(0.12)
        .polygonsData(mapData)
        .polygonCapColor(d => {
            const ownerColor = getOwnerColor(d.properties.owner);
            const prog = invasionProgress[d.properties.ADMIN];
            if (prog && prog.active) {
                const targetColor = getOwnerColor(prog.attacker);
                return `rgba(${hexToRgb(targetColor)}, ${prog.val})`;
            }
            if (hoverCountry === d) return ownerColor + 'cc';
            return ownerColor;
        })
        .polygonSideColor(() => 'rgba(255,255,255,0.05)')
        .polygonStrokeColor(() => 'rgba(0,0,0,0.3)')
        .polygonAltitude(0.01)
        .polygonLabel(d => createTooltip(d))
        .onPolygonHover(d => {
            hoverCountry = d;
            if (world) world.polygonCapColor(world.polygonCapColor());
        })
        .onPolygonClick((d, e) => handlePolygonClick(d, e))
        .onPolygonRightClick((d, e) => showCtxMenu(d, e));

    world.controls().autoRotate = true;
    world.controls().autoRotateSpeed = 0.5;

    world.onGlobeClick((coords, event) => {
        if (activeMode !== 'builder' || !player.active || !isDrawing) return;
        let point = [coords.lng, coords.lat];
        const coastlines = { type: 'FeatureCollection', features: mapData };
        point = snapToCoast({ type: 'Point', coordinates: point }, coastlines);
        if (event.shiftKey && drawnPoints.length > 0) {
            let closestIdx = 0; let minDist = Infinity;
            drawnPoints.forEach((p, idx) => {
                const dist = Math.pow(p[0] - point[0], 2) + Math.pow(p[1] - point[1], 2);
                if (dist < minDist) { minDist = dist; closestIdx = idx; }
            });
            drawnPoints[closestIdx] = point;
        } else { drawnPoints.push(point); }
        world.pathsData([{ coords: drawnPoints.map(p => [p[1], p[0]]) }]);
        hasUnsavedChanges = true;
    });
}

function hexToRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${r}, ${g}, ${b}`;
}

function setupUIEvents() {
    document.querySelectorAll('.mode-card').forEach(card => {
        card.addEventListener('click', (e) => {
            document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('active'));
            const target = e.currentTarget;
            target.classList.add('active');
            activeMode = target.getAttribute('data-mode');
        });
    });

    const searchInput = document.getElementById('start-country');
    const resultsDiv = document.getElementById('search-results');
    
    searchInput.addEventListener('input', (e) => {
        const val = e.target.value.toLowerCase();
        if (!val) { resultsDiv.style.display = 'none'; return; }
        
        // SUPPORT ABBREVIATIONS: Check ADMIN and ADM0_A3
        const matches = mapData.filter(f => 
            f.properties.ADMIN.toLowerCase().includes(val) || 
            (f.properties.ADM0_A3 && f.properties.ADM0_A3.toLowerCase() === val)
        );

        if (matches.length > 0) {
            resultsDiv.innerHTML = matches.slice(0, 8).map(m => 
                `<div class="search-item">${m.properties.ADMIN} ${m.properties.ADM0_A3 ? `(${m.properties.ADM0_A3})` : ''}</div>`
            ).join('');
            resultsDiv.style.display = 'block';
            
            document.querySelectorAll('.search-item').forEach(item => {
                item.addEventListener('click', (ev) => {
                    const name = ev.target.innerText.split(' (')[0];
                    searchInput.value = name;
                    resultsDiv.style.display = 'none';
                });
            });
        } else { resultsDiv.style.display = 'none'; }
    });

    document.addEventListener('click', (e) => {
        if(e.target !== searchInput && e.target !== resultsDiv) resultsDiv.style.display = 'none';
        if(e.button !== 2) document.getElementById('ctx-menu').style.display = 'none';
    });

    document.getElementById('btn-draw').onclick = () => {
        isDrawing = !isDrawing;
        const btn = document.getElementById('btn-draw');
        if (isDrawing) btn.classList.add('active');
        else btn.classList.remove('active');
    };

    document.getElementById('btn-save-build').onclick = () => {
        if (drawnPoints.length < 3) return;
        const newName = prompt("Nation Identity:");
        if (newName) {
            mapData.push({
                type: 'Feature',
                properties: { ADMIN: newName, owner: newName, MAPCOLOR7: Math.floor(Math.random()*7)+1, gameStats: { pop: 5000000, mil: 50000 } },
                geometry: { type: 'Polygon', coordinates: [[...drawnPoints, drawnPoints[0]]] }
            });
            setupNeighborhoods();
            world.polygonsData(mapData);
            drawnPoints = [];
            world.pathsData([]);
            hasUnsavedChanges = true;
        }
    };
}

function startDeployment() {
    const query = document.getElementById('start-country').value.trim().toLowerCase();
    const startNode = mapData.find(f => f.properties.ADMIN.toLowerCase() === query);
    if (!startNode) return alert("Identify origin point.");

    player.active = true;
    player.empireName = startNode.properties.ADMIN;
    isPaused = false;
    hasUnsavedChanges = false;
    
    document.getElementById('setup-screen').style.display = 'none';
    document.getElementById('status-bar').style.display = 'flex';
    document.getElementById('leaderboard').style.display = 'flex';
    document.getElementById('controls').style.display = 'flex';
    
    if (activeMode === 'builder') {
        document.getElementById('builder-overlay').style.display = 'flex';
    }

    world.controls().autoRotate = false;
    const centroid = getCentroid(startNode);
    world.pointOfView({ lat: centroid[1], lng: centroid[0], altitude: 1.2 }, 2000);

    updateUI();
    updateLeaderboard();
    logMsg(`System Online: ${startNode.properties.ADMIN}`);

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
    document.getElementById('val-empire').innerText = player.empireName;
    document.getElementById('val-terr').innerText = playerLands.length;
    document.getElementById('val-mil').innerText = formatNum(player.stats.mil);
    world.polygonsData(mapData);
}

function updateLeaderboard() {
    if (activeMode === 'builder') {
        document.getElementById('leaderboard').style.display = 'none';
        return;
    }
    const lbList = document.getElementById('lb-list');
    let scores = {};
    mapData.forEach(f => {
        const owner = f.properties.owner;
        if(!scores[owner]) scores[owner] = { terr: 0, mil: 0 };
        scores[owner].terr++;
        scores[owner].mil += f.properties.gameStats.mil;
    });
    const sorted = Object.entries(scores)
        .sort((a,b) => b[1].terr - a[1].terr || b[1].mil - a[1].mil)
        .slice(0, 15);

    lbList.innerHTML = sorted.map((entry, idx) => `
        <div class="lb-item ${entry[0] === player.empireName ? 'player' : ''}" onclick="window.locateNation('${entry[0]}')">
            <span class="lb-name">${idx + 1}. ${entry[0]}</span>
            <span class="lb-val">${entry[1].terr}<span class="lb-sub">S</span> / ${formatNum(entry[1].mil)}<span class="lb-sub">M</span></span>
        </div>
    `).join('');
}

function logMsg(msg) {
    const log = document.getElementById('combat-log');
    log.innerText = msg.toUpperCase();
}

function createTooltip(d) {
    if (!player.active) return '';
    const p = d.properties;
    const stats = p.gameStats;
    const ownerColor = getOwnerColor(p.owner);
    return `
        <div class="tactical-tooltip">
            <div style="font-weight:700; border-bottom:1px solid #333; padding-bottom:6px; margin-bottom:6px; display:flex; justify-content:space-between;">
                ${p.ADMIN}
                <span style="color:${ownerColor}; font-size:0.6rem; font-weight:800;">${p.owner}</span>
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
    if (!isBordering) return logMsg("Not Bordering Target Sector");
    executeInvasion(player.empireName, d);
    hasUnsavedChanges = true;
}

function showCtxMenu(d, e) {
    if (!player.active || activeMode === 'builder' || isPaused) return;
    if (d.properties.owner === player.empireName) return;
    const menu = document.getElementById('ctx-menu');
    menu.style.display = 'block';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    window.lastCtxTarget = d;
}

function executeAction(type) {
    const target = window.lastCtxTarget;
    document.getElementById('ctx-menu').style.display = 'none';
    if (!target) return;
    if (type === 'invade') handlePolygonClick(target);
    if (type === 'nuke') { launchStrike(player.empireName, target); hasUnsavedChanges = true; }
}

function executeInvasion(attackerName, targetFeature) {
    const targetName = targetFeature.properties.ADMIN;
    if (invasionProgress[targetName] && invasionProgress[targetName].active) return;
    const attackerLands = mapData.filter(f => f.properties.owner === attackerName);
    let attMil = attackerLands.reduce((sum, f) => sum + f.properties.gameStats.mil, 0);
    let defMil = targetFeature.properties.gameStats.mil;
    if (defMil > attMil * 2.5) {
        if (attackerName === player.empireName) logMsg(`Insufficient Force for ${targetName}`);
        return;
    }
    const tCentroid = getCentroid(targetFeature);
    const sCentroid = getCentroid(attackerLands[0]); 
    activeArcs.push({
        startLat: sCentroid[1], startLng: sCentroid[0],
        endLat: tCentroid[1], endLng: tCentroid[0],
        color: [getOwnerColor(attackerName), '#ffffff']
    });
    world.arcsData(activeArcs);
    invasionProgress[targetName] = { active: true, val: 0, attacker: attackerName };
    const duration = 2000 + (defMil / 50000) * 1000;
    const start = Date.now();
    const anim = () => {
        if (isPaused) { invasionProgress[targetName].startTime = (invasionProgress[targetName].startTime || start) + 16; requestAnimationFrame(anim); return; }
        const elapsed = Date.now() - (invasionProgress[targetName].startTime || start);
        const prog = Math.min(1, elapsed / duration);
        invasionProgress[targetName].val = prog;
        if (world) world.polygonCapColor(world.polygonCapColor());
        if (prog < 1) requestAnimationFrame(anim);
        else {
            activeArcs = activeArcs.filter(a => a.endLat !== tCentroid[1] || a.endLng !== tCentroid[0]);
            world.arcsData(activeArcs);
            invasionProgress[targetName].active = false;
            if (attMil > defMil * 1.05) {
                targetFeature.properties.owner = attackerName;
                targetFeature.properties.gameStats.mil = Math.floor(attMil * 0.05);
                attackerLands.forEach(f => f.properties.gameStats.mil = Math.floor(f.properties.gameStats.mil * 0.9));
                if (attackerName === player.empireName) logMsg(`Annexed: ${targetName}`);
            } else {
                attackerLands.forEach(f => f.properties.gameStats.mil = Math.floor(f.properties.gameStats.mil * 0.5));
                if (attackerName === player.empireName) logMsg(`Failed Assault: ${targetName}`);
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
    activeArcs.push({
        startLat: startCentroid[1], startLng: startCentroid[0],
        endLat: centroid[1], endLng: centroid[0],
        color: ['#ffffff', '#ee0000']
    });
    world.arcsData(activeArcs);
    setTimeout(() => {
        activeArcs = activeArcs.filter(a => a.endLat !== centroid[1] || a.endLng !== centroid[0]);
        world.arcsData(activeArcs);
        confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 }, colors: ['#ff4d4d', '#ffca28', '#333333'], scalar: 1.2, gravity: 2 });
        document.body.classList.add('shake');
        activeRings.push({ lat: centroid[1], lng: centroid[0], maxR: 25, speed: 6, repeat: 0, color: '#ee0000' });
        world.ringsData(activeRings);
        targetFeature.properties.gameStats.pop = Math.floor(targetFeature.properties.gameStats.pop * 0.1);
        targetFeature.properties.gameStats.mil = Math.floor(targetFeature.properties.gameStats.mil * 0.05);
        logMsg(`GRID DOWN: ${targetFeature.properties.ADMIN}`);
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
        let target;
        if (activeMode === 'survival') {
            const playerTargets = potentialTargets.filter(t => t.properties.owner === player.empireName);
            target = playerTargets.length > 0 ? playerTargets[Math.floor(Math.random() * playerTargets.length)] : potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
        } else { target = potentialTargets[Math.floor(Math.random() * potentialTargets.length)]; }
        const totalMil = myLands.reduce((sum, f) => sum + f.properties.gameStats.mil, 0);
        if (totalMil > target.properties.gameStats.mil * 1.5 && target.properties.gameStats.mil < totalMil * 0.6) executeInvasion(emp, target);
    });
    updateUI(); updateLeaderboard();
    if (mapData.filter(f => f.properties.owner === player.empireName).length === 0) {
        logMsg("DEFEAT: DOMAIN COLLAPSED");
        player.active = false;
        clearInterval(aiInterval);
    }
}

async function pauseAndSaveGame() {
    isPaused = !isPaused;
    const btn = document.getElementById('btn-pause-save');
    if (isPaused) {
        btn.innerHTML = '<i class="fa-solid fa-play"></i> Resume';
        logMsg("Game Paused");
        await saveCampaign();
    } else {
        btn.innerHTML = '<i class="fa-solid fa-pause"></i> Pause & Save';
        logMsg("Game Resumed");
    }
}

async function saveCampaign() {
    document.getElementById('saving-overlay').style.display = 'flex';
    const db = await dbPromise;
    const saveObj = {
        id: Date.now(),
        date: new Date().toLocaleString(),
        mode: activeMode,
        empire: player.empireName,
        mapState: mapData.map(f => ({ admin: f.properties.ADMIN, owner: f.properties.owner, stats: f.properties.gameStats }))
    };
    return new Promise(resolve => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(saveObj);
        tx.oncomplete = () => {
            setTimeout(() => {
                document.getElementById('saving-overlay').style.display = 'none';
                logMsg("Backup successful");
                hasUnsavedChanges = false;
                loadSavesFromDB();
                resolve();
            }, 800);
        };
    });
}

async function loadSavesFromDB() {
    const db = await dbPromise;
    const savesList = document.getElementById('saves-list');
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => {
        const saves = request.result.reverse().slice(0, 10);
        if (saves.length === 0) return;
        savesList.innerHTML = saves.map(s => `
            <div class="save-item" onclick="window.restoreFromDB(${s.id})">
                <div class="title">${s.empire.toUpperCase()}</div>
                <div class="meta">${s.mode.toUpperCase()} • ${s.date}</div>
            </div>
        `).join('');
    };
}

window.restoreFromDB = async (id) => {
    const db = await dbPromise;
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => {
        const save = request.result;
        if (!save) return;
        activeMode = save.mode;
        player.empireName = save.empire;
        mapData.forEach(f => {
            const savedNode = save.mapState.find(n => n.admin === f.properties.ADMIN);
            if (savedNode) { f.properties.owner = savedNode.owner; f.properties.gameStats = savedNode.stats; }
        });
        document.getElementById('start-country').value = player.empireName;
        startDeployment();
    };
};

function exitToMenuFlow() {
    if (hasUnsavedChanges) {
        if (!confirm("Exit without saving? Unsaved tactical progress will be lost.")) return;
    }
    location.reload();
}

init();
