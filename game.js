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
let aiInterval = null;
let activeArcs = [];
let activeRings = [];

// Hardcoded vivid colors based on MAPCOLOR7
const COLORS = {
    1: '#ff4d4d', // Red
    2: '#0070f3', // Vercel Blue
    3: '#00dfd8', // Cyan
    4: '#ffca28', // Amber
    5: '#7928ca', // Purple
    6: '#ff0080', // Pink
    7: '#50e3c2'  // Teal
};

function getCountryColor(feature) {
    if (!feature || !feature.properties) return '#fff';
    const mc = feature.properties.MAPCOLOR7;
    return COLORS[mc] || `hsl(${Math.abs(feature.properties.ADMIN.charCodeAt(0) * 20) % 360}, 70%, 50%)`;
}

function getOwnerColor(ownerName) {
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
            f.properties.gameStats = {
                pop: pop,
                mil: Math.floor(pop * 0.01)
            };
            return f;
        });

        resetMapData();
        setupNeighborhoods();
        setupWorld();
        setupUIEvents();
        loadSaves();
        
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
            if (dist < 15) {
                c1.properties.neighbors.push(c2.properties.ADMIN);
            }
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
            // Fix: Maintain color on hover by reducing alpha instead of disappearing
            if (hoverCountry === d) {
                return ownerColor + 'cc'; // 0.8 opacity hex
            }
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

    // Builder click handling
    world.onGlobeClick((coords, event) => {
        if (activeMode !== 'builder' || !player.active || !isDrawing) return;
        
        let point = [coords.lng, coords.lat];
        const coastlines = { type: 'FeatureCollection', features: mapData };
        point = snapToCoast({ type: 'Point', coordinates: point }, coastlines);

        if (event.shiftKey && drawnPoints.length > 0) {
            let closestIdx = 0;
            let minDist = Infinity;
            drawnPoints.forEach((p, idx) => {
                const dist = Math.pow(p[0] - point[0], 2) + Math.pow(p[1] - point[1], 2);
                if (dist < minDist) { minDist = dist; closestIdx = idx; }
            });
            drawnPoints[closestIdx] = point;
        } else {
            drawnPoints.push(point);
        }
        
        world.pathsData([{ coords: drawnPoints.map(p => [p[1], p[0]]) }]);
    });
}

function setupUIEvents() {
    // Mode Grid
    document.querySelectorAll('.mode-card').forEach(card => {
        card.addEventListener('click', (e) => {
            document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('active'));
            const target = e.currentTarget;
            target.classList.add('active');
            activeMode = target.getAttribute('data-mode');
        });
    });

    // Search
    const searchInput = document.getElementById('start-country');
    const resultsDiv = document.getElementById('search-results');
    
    searchInput.addEventListener('input', (e) => {
        const val = e.target.value.toLowerCase();
        if (!val) { resultsDiv.style.display = 'none'; return; }
        
        const matches = mapData.filter(f => f.properties.ADMIN.toLowerCase().includes(val));
        if (matches.length > 0) {
            resultsDiv.innerHTML = matches.slice(0, 8).map(m => 
                `<div class="search-item">${m.properties.ADMIN}</div>`
            ).join('');
            resultsDiv.style.display = 'block';
            
            document.querySelectorAll('.search-item').forEach(item => {
                item.addEventListener('click', (ev) => {
                    searchInput.value = ev.target.innerText;
                    resultsDiv.style.display = 'none';
                });
            });
        } else {
            resultsDiv.style.display = 'none';
        }
    });

    document.addEventListener('click', (e) => {
        if(e.target !== searchInput && e.target !== resultsDiv) resultsDiv.style.display = 'none';
        if(e.button !== 2) document.getElementById('ctx-menu').style.display = 'none';
    });

    // Builder remade
    document.getElementById('btn-draw').onclick = () => {
        isDrawing = !isDrawing;
        const btn = document.getElementById('btn-draw');
        if (isDrawing) {
            btn.classList.add('active');
            logMsg("Edit Mode Active: Plot or Shift+Drag");
        } else {
            btn.classList.remove('active');
            logMsg("Edit Mode Suspended");
        }
    };

    document.getElementById('btn-save-build').onclick = () => {
        if (drawnPoints.length < 3) return logMsg("Minimum 3 nodes required");
        const newName = prompt("Nation Identity:");
        if (newName) {
            mapData.push({
                type: 'Feature',
                properties: { 
                    ADMIN: newName, 
                    owner: newName, 
                    MAPCOLOR7: Math.floor(Math.random()*7)+1, 
                    gameStats: { pop: 5000000, mil: 50000 } 
                },
                geometry: { type: 'Polygon', coordinates: [[...drawnPoints, drawnPoints[0]]] }
            });
            setupNeighborhoods();
            world.polygonsData(mapData);
            drawnPoints = [];
            world.pathsData([]);
            logMsg(`Nation Established: ${newName}`);
        }
    };
}

function startDeployment() {
    const query = document.getElementById('start-country').value.trim().toLowerCase();
    const startNode = mapData.find(f => f.properties.ADMIN.toLowerCase() === query);
    if (!startNode) return alert("Identify origin point.");

    player.active = true;
    player.empireName = startNode.properties.ADMIN;
    
    document.getElementById('setup-screen').style.display = 'none';
    document.getElementById('status-bar').style.display = 'flex';
    document.getElementById('leaderboard').style.display = 'flex';
    
    if (activeMode === 'builder') {
        document.getElementById('builder-overlay').style.display = 'flex';
    }

    world.controls().autoRotate = false;
    const centroid = getCentroid(startNode);
    world.pointOfView({ lat: centroid[1], lng: centroid[0], altitude: 1.2 }, 2000);

    updateUI();
    updateLeaderboard();
    logMsg(`Deployment: ${startNode.properties.ADMIN}`);

    if (activeMode !== 'builder') {
        if (aiInterval) clearInterval(aiInterval);
        aiInterval = setInterval(gameTick, 2000);
    }
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
        .slice(0, 10);

    lbList.innerHTML = sorted.map((entry, idx) => `
        <div class="lb-item ${entry[0] === player.empireName ? 'player' : ''}">
            <span>${idx + 1}. ${entry[0]}</span>
            <span>${entry[1].terr} / ${formatNum(entry[1].mil)}</span>
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
                <span style="color:${ownerColor}; font-size:0.6rem;">${p.owner}</span>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:0.65rem; color:#888;">
                <span>Personnel</span>
                <span style="color:#fff;">${formatNum(stats.pop)}</span>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:0.65rem; color:#888;">
                <span>Military</span>
                <span style="color:#fff;">${formatNum(stats.mil)}</span>
            </div>
        </div>
    `;
}

function handlePolygonClick(d, e) {
    if (!player.active || activeMode === 'builder') return;
    if (d.properties.owner === player.empireName) return;
    executeInvasion(player.empireName, d);
}

function showCtxMenu(d, e) {
    if (!player.active || activeMode === 'builder') return;
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

    if (type === 'invade') executeInvasion(player.empireName, target);
    if (type === 'nuke') launchStrike(player.empireName, target);
}

function executeInvasion(attackerName, targetFeature) {
    const attackerLands = mapData.filter(f => f.properties.owner === attackerName);
    if (attackerLands.length === 0) return;

    const targetName = targetFeature.properties.ADMIN;
    let attMil = attackerLands.reduce((sum, f) => sum + f.properties.gameStats.mil, 0);
    let defMil = targetFeature.properties.gameStats.mil;

    if (attMil > defMil * 1.05) {
        targetFeature.properties.owner = attackerName;
        targetFeature.properties.gameStats.mil = Math.floor(attMil * 0.05);
        attackerLands.forEach(f => f.properties.gameStats.mil = Math.floor(f.properties.gameStats.mil * 0.9));
        if (attackerName === player.empireName) logMsg(`Sektor Acquired: ${targetName}`);
    } else {
        attackerLands.forEach(f => f.properties.gameStats.mil = Math.floor(f.properties.gameStats.mil * 0.5));
        if (attackerName === player.empireName) logMsg(`Assault Repelled: ${targetName}`);
    }

    updateUI();
    updateLeaderboard();
}

function launchStrike(attackerName, targetFeature) {
    const centroid = getCentroid(targetFeature);
    const startNode = mapData.find(f => f.properties.owner === attackerName);
    const startCentroid = getCentroid(startNode);

    activeArcs.push({
        startLat: startCentroid[1], startLng: startCentroid[0],
        endLat: centroid[1], endLng: centroid[0],
        color: ['#ffffff', '#ee0000']
    });
    world.arcsData(activeArcs);

    setTimeout(() => {
        activeArcs = []; world.arcsData([]);
        activeRings.push({ lat: centroid[1], lng: centroid[0], maxR: 15, speed: 5, repeat: 0, color: '#ee0000' });
        world.ringsData(activeRings);
        
        targetFeature.properties.gameStats.pop = Math.floor(targetFeature.properties.gameStats.pop * 0.1);
        targetFeature.properties.gameStats.mil = Math.floor(targetFeature.properties.gameStats.mil * 0.05);
        logMsg(`Target Nullified: ${targetFeature.properties.ADMIN}`);
        updateUI();
        
        setTimeout(() => { activeRings = []; world.ringsData([]); }, 2000);
    }, 1000);
}

function gameTick() {
    if (!player.active) return;

    mapData.forEach(f => {
        f.properties.gameStats.mil += Math.floor(f.properties.gameStats.pop * 0.003);
    });

    const empiresList = [...new Set(mapData.map(f => f.properties.owner))];

    empiresList.forEach(emp => {
        if (emp === player.empireName) return;

        const myLands = mapData.filter(f => f.properties.owner === emp);
        if (myLands.length === 0) return;

        let potentialTargets = [];
        myLands.forEach(land => {
            land.properties.neighbors.forEach(nName => {
                const nNode = mapData.find(f => f.properties.ADMIN === nName);
                if (nNode && nNode.properties.owner !== emp) {
                    potentialTargets.push(nNode);
                }
            });
        });

        if (potentialTargets.length === 0) return;

        let target;
        if (activeMode === 'survival') {
            const playerTargets = potentialTargets.filter(t => t.properties.owner === player.empireName);
            target = playerTargets.length > 0 ? playerTargets[Math.floor(Math.random() * playerTargets.length)] : potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
        } else {
            target = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
        }

        const totalMil = myLands.reduce((sum, f) => sum + f.properties.gameStats.mil, 0);
        if (totalMil > target.properties.gameStats.mil * 1.5) {
            executeInvasion(emp, target);
        }
    });

    updateUI();
    updateLeaderboard();

    if (mapData.filter(f => f.properties.owner === player.empireName).length === 0) {
        logMsg("Network Collapse: Connection Lost");
        player.active = false;
        clearInterval(aiInterval);
    }
}

function saveCampaign() {
    const saves = JSON.parse(localStorage.getItem('geo_v2_saves') || '[]');
    saves.push({
        id: Date.now(),
        date: new Date().toLocaleString(),
        mode: activeMode,
        empire: player.empireName,
        mapState: mapData.map(f => ({ admin: f.properties.ADMIN, owner: f.properties.owner, stats: f.properties.gameStats }))
    });
    localStorage.setItem('geo_v2_saves', JSON.stringify(saves));
}

function loadSaves() {
    const savesList = document.getElementById('saves-list');
    const saves = JSON.parse(localStorage.getItem('geo_v2_saves') || '[]');
    if (saves.length === 0) return;
    
    savesList.innerHTML = saves.reverse().slice(0, 5).map(s => `
        <div class="save-item" onclick="window.restoreSave(${s.id})">
            <div class="title">${s.empire}</div>
            <div class="meta">${s.mode.toUpperCase()} • ${s.date}</div>
        </div>
    `).join('');
}

window.restoreSave = (id) => {
    const saves = JSON.parse(localStorage.getItem('geo_v2_saves') || '[]');
    const save = saves.find(s => s.id === id);
    if (!save) return;

    activeMode = save.mode;
    player.empireName = save.empire;
    mapData.forEach(f => {
        const savedNode = save.mapState.find(n => n.admin === f.properties.ADMIN);
        if (savedNode) {
            f.properties.owner = savedNode.owner;
            f.properties.gameStats = savedNode.stats;
        }
    });

    document.getElementById('start-country').value = player.empireName;
    startDeployment();
};

init();
