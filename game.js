/**
 * Geopolitics - Main Engine
 */

import { formatNum, getFuzzy, getCentroid, snapToCoast } from './utils.js';

let world;
let mapData = [];
let originalMapData = [];

// Game State
let player = { active: false, empireName: '', stats: { pop: 0, mil: 0 } };
let activeMode = 'takeover'; // takeover, survival, builder
let hoverCountry = null;
let drawnPoints = [];
let isDrawing = false;
let aiInterval = null;
let activeArcs = [];
let activeRings = [];

// Hardcoded vivid colors based on MAPCOLOR7
const COLORS = {
    1: '#e74c3c', // Red
    2: '#3498db', // Blue
    3: '#2ecc71', // Green
    4: '#f1c40f', // Yellow
    5: '#9b59b6', // Purple
    6: '#e67e22', // Orange
    7: '#1abc9c'  // Teal
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
    else logMsg("Interface initializing...");
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
        console.error("Critical Engine Failure:", err);
        logMsg("Data Link Failure");
    }
}

function resetMapData() {
    mapData = JSON.parse(JSON.stringify(originalMapData));
}

// Pre-calculate adjacent neighbors for fast AI
function setupNeighborhoods() {
    mapData.forEach(c1 => {
        c1.properties.neighbors = [];
        const cent1 = getCentroid(c1);
        mapData.forEach(c2 => {
            if (c1 === c2) return;
            const cent2 = getCentroid(c2);
            const dist = Math.sqrt(Math.pow(cent1[0] - cent2[0], 2) + Math.pow(cent1[1] - cent2[1], 2));
            if (dist < 15) { // Roughly neighbors threshold
                c1.properties.neighbors.push(c2.properties.ADMIN);
            }
        });
    });
}

function setupWorld() {
    world = Globe()(document.getElementById('globe-container'))
        .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-water.png')
        .backgroundColor('#0f172a')
        .showAtmosphere(true)
        .atmosphereColor('#00cec9')
        .atmosphereAltitude(0.15)
        .polygonsData(mapData)
        .polygonCapColor(d => {
            if (!player.active) return 'rgba(0,0,0,0.1)';
            const ownerColor = getOwnerColor(d.properties.owner);
            if (hoverCountry === d) return 'rgba(255, 255, 255, 0.5)';
            return ownerColor;
        })
        .polygonSideColor(() => 'rgba(0,0,0,0.2)')
        .polygonStrokeColor(() => 'rgba(0,0,0,0.5)')
        .polygonAltitude(0.01)
        .polygonLabel(d => createTooltip(d))
        .onPolygonHover(d => {
            hoverCountry = d;
            if (world && player.active) world.polygonCapColor(world.polygonCapColor());
        })
        .onPolygonClick((d, e) => handlePolygonClick(d, e))
        .onPolygonRightClick((d, e) => showCtxMenu(d, e));

    world.controls().autoRotate = true;
    world.controls().autoRotateSpeed = 0.5;

    // Builder mode setup
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
    // Modes
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
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

    // Builder toggle
    document.getElementById('btn-draw').onclick = () => {
        isDrawing = !isDrawing;
        const btn = document.getElementById('btn-draw');
        if (isDrawing) {
            btn.classList.add('active');
            drawnPoints = [];
            logMsg("Builder Active. Click to plot. Shift+Click to drag.");
        } else {
            btn.classList.remove('active');
            if (drawnPoints.length > 2) {
                const newName = prompt("Custom Nation Name:");
                if (newName) {
                    mapData.push({
                        type: 'Feature',
                        properties: { ADMIN: newName, owner: newName, MAPCOLOR7: Math.floor(Math.random()*7)+1, gameStats: { pop: 5000000, mil: 50000 } },
                        geometry: { type: 'Polygon', coordinates: [[...drawnPoints, drawnPoints[0]]] }
                    });
                    setupNeighborhoods();
                    world.polygonsData(mapData);
                    logMsg(`Constructed ${newName}`);
                }
            }
            drawnPoints = [];
            world.pathsData([]);
        }
    };
}

// ---- GAME LOOP & DEPLOYMENT ----

function startDeployment() {
    const query = document.getElementById('start-country').value.trim().toLowerCase();
    const startNode = mapData.find(f => f.properties.ADMIN.toLowerCase() === query);
    if (!startNode) return alert("Nation not found. Please select from search.");

    player.active = true;
    player.empireName = startNode.properties.ADMIN;
    
    document.getElementById('setup-screen').style.display = 'none';
    document.getElementById('status-bar').style.display = 'flex';
    document.getElementById('leaderboard').style.display = 'flex';
    
    if (activeMode === 'builder') {
        document.getElementById('controls').style.display = 'flex';
        document.getElementById('btn-draw').style.display = 'block';
    }

    document.getElementById('val-mode').innerText = activeMode.toUpperCase();
    world.controls().autoRotate = false;
    
    const centroid = getCentroid(startNode);
    world.pointOfView({ lat: centroid[1], lng: centroid[0], altitude: 1.5 }, 2000);

    // Initial Stats
    startNode.properties.gameStats.mil *= 2; // Player buff

    updateUI();
    updateLeaderboard();
    logMsg(`Deployment successful in ${startNode.properties.ADMIN}.`);

    if (activeMode !== 'builder') {
        if (aiInterval) clearInterval(aiInterval);
        aiInterval = setInterval(gameTick, 2500);
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
    world.polygonCapColor(world.polygonCapColor());
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
        <div class="lb-item ${entry[0] === player.empireName ? 'player' : ''}">
            <span class="lb-name">${idx + 1}. ${entry[0]}</span>
            <span class="lb-stats">${entry[1].terr} / ${formatNum(entry[1].mil)}</span>
        </div>
    `).join('');
}

function logMsg(msg) {
    const log = document.getElementById('combat-log');
    log.innerText = `SYS // ${msg.toUpperCase()}`;
}

function createTooltip(d) {
    if (!player.active) return '';
    const p = d.properties;
    const stats = p.gameStats;
    const ownerColor = getOwnerColor(p.owner);
    
    return `
        <div class="tactical-tooltip">
            <div class="tt-header">
                ${p.ADMIN}
                <span class="tt-owner-badge" style="background: ${ownerColor};">${p.owner}</span>
            </div>
            <div class="tt-row"><span>Population</span> <span class="tt-val">${formatNum(stats.pop)}</span></div>
            <div class="tt-row"><span>Military</span> <span class="tt-val">${formatNum(stats.mil)}</span></div>
        </div>
    `;
}

// ---- INTERACTION & COMBAT ----

function handlePolygonClick(d, e) {
    if (!player.active || activeMode === 'builder') return;
    if (d.properties.owner === player.empireName) return;
    
    // Player manually invades
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

    // Simulate combat
    if (attMil > defMil * 1.1) {
        // Success
        targetFeature.properties.owner = attackerName;
        targetFeature.properties.gameStats.mil = Math.floor(attMil * 0.1); // Leave garrison
        attackerLands.forEach(f => f.properties.gameStats.mil = Math.floor(f.properties.gameStats.mil * 0.8));
        
        if (attackerName === player.empireName) logMsg(`Annexed ${targetName}.`);
        else if (targetFeature.properties.owner === player.empireName) logMsg(`CRITICAL: Lost ${targetName} to ${attackerName}.`);
    } else {
        // Fail
        targetFeature.properties.gameStats.mil = Math.floor(defMil * 0.7);
        attackerLands.forEach(f => f.properties.gameStats.mil = Math.floor(f.properties.gameStats.mil * 0.5));
        if (attackerName === player.empireName) logMsg(`Invasion of ${targetName} failed.`);
    }

    if (attackerName === player.empireName || targetFeature.properties.owner === player.empireName) {
        updateUI();
        updateLeaderboard();
    }
}

function launchStrike(attackerName, targetFeature) {
    const centroid = getCentroid(targetFeature);
    const startNode = mapData.find(f => f.properties.owner === attackerName);
    const startCentroid = getCentroid(startNode);

    activeArcs.push({
        startLat: startCentroid[1], startLng: startCentroid[0],
        endLat: centroid[1], endLng: centroid[0],
        color: ['#ffffff', '#ff4757']
    });
    world.arcsData(activeArcs);

    setTimeout(() => {
        activeArcs = []; world.arcsData([]);
        activeRings.push({ lat: centroid[1], lng: centroid[0], maxR: 15, speed: 5, repeat: 0, color: '#ff4757' });
        world.ringsData(activeRings);
        
        targetFeature.properties.gameStats.pop = Math.floor(targetFeature.properties.gameStats.pop * 0.1);
        targetFeature.properties.gameStats.mil = Math.floor(targetFeature.properties.gameStats.mil * 0.1);
        if (attackerName === player.empireName) logMsg(`Nuclear strike confirmed on ${targetFeature.properties.ADMIN}.`);
        updateUI();
        
        setTimeout(() => { activeRings = []; world.ringsData([]); }, 2000);
    }, 1000);
}

// ---- AI LOOP ----

function gameTick() {
    if (!player.active) return;

    // Passive Growth
    mapData.forEach(f => {
        f.properties.gameStats.mil += Math.floor(f.properties.gameStats.pop * 0.002);
    });

    const empiresList = [...new Set(mapData.map(f => f.properties.owner))];

    empiresList.forEach(emp => {
        if (emp === player.empireName) return; // Player manual control

        const myLands = mapData.filter(f => f.properties.owner === emp);
        if (myLands.length === 0) return;

        let potentialTargets = [];
        
        // Find neighbor targets
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
        
        // AI aggressiveness check
        if (totalMil > target.properties.gameStats.mil * 1.5) {
            executeInvasion(emp, target);
        }
    });

    updateUI();
    updateLeaderboard();

    // Check Death
    if (mapData.filter(f => f.properties.owner === player.empireName).length === 0) {
        logMsg("CRITICAL: EMPIRE COLLAPSED. SYSTEM TERMINATED.");
        player.active = false;
        clearInterval(aiInterval);
    }
}

// ---- SAVES ----

function saveCampaign() {
    const saves = JSON.parse(localStorage.getItem('geo_saves') || '[]');
    saves.push({
        id: Date.now(),
        date: new Date().toLocaleString(),
        mode: activeMode,
        empire: player.empireName,
        mapState: mapData.map(f => ({ admin: f.properties.ADMIN, owner: f.properties.owner, stats: f.properties.gameStats }))
    });
    localStorage.setItem('geo_saves', JSON.stringify(saves));
    logMsg("Campaign State Backed Up.");
}

function loadSaves() {
    const savesList = document.getElementById('saves-list');
    const saves = JSON.parse(localStorage.getItem('geo_saves') || '[]');
    if (saves.length === 0) return;
    
    savesList.innerHTML = saves.reverse().slice(0, 5).map(s => `
        <div class="save-card" onclick="window.restoreSave(${s.id})">
            <div class="save-title">${s.empire.toUpperCase()}</div>
            <div class="save-meta">
                <span>Mode: ${s.mode}</span>
                <span>${s.date}</span>
            </div>
        </div>
    `).join('');
}

window.restoreSave = (id) => {
    const saves = JSON.parse(localStorage.getItem('geo_saves') || '[]');
    const save = saves.find(s => s.id === id);
    if (!save) return;

    activeMode = save.mode;
    player.empireName = save.empire;
    
    // Restore state
    mapData.forEach(f => {
        const savedNode = save.mapState.find(n => n.admin === f.properties.ADMIN);
        if (savedNode) {
            f.properties.owner = savedNode.owner;
            f.properties.gameStats = savedNode.stats;
        }
    });

    // Boot UI
    document.getElementById('start-country').value = player.empireName;
    startDeployment();
};

init();
