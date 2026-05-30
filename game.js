/**
 * Geopolitics - Main Engine
 */

import { formatNum, getFuzzy, getCentroid, mergeCountries, snapToCoast } from './utils.js';

let world;
let mapData = [];
let player = {
    active: false,
    empire: [],
    allies: [],
    enemies: [],
    stats: { pop: 0, mil: 0, econ: 0 }
};

let hoverCountry = null;
let activeInvasionTarget = null;
let isFighting = false;
let isBuildMode = false;
let isMergeMode = false;
let mergeSelection = [];
let drawnPoints = [];
let activeRings = [];
let activeArcs = [];

const GEO_URL = 'https://unpkg.com/three-globe/example/img/custom.geo.json';

// Initialize the engine
async function init() {
    const res = await fetch(GEO_URL);
    const data = await res.json();
    
    mapData = data.features.map(f => {
        const p = f.properties;
        const pop = p.POP_EST || 1000000;
        const gdp = p.GDP_MD_EST || 10000;
        f.properties.gameStats = {
            pop: pop,
            mil: Math.floor(pop * 0.01),
            econ: gdp * 1000000
        };
        return f;
    });

    world = Globe()(document.getElementById('globe-container'))
        .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-dark.jpg')
        .backgroundColor('#020204')
        .showAtmosphere(true)
        .atmosphereColor('#00f2ff')
        .atmosphereAltitude(0.1)
        .polygonsData(mapData)
        .polygonCapColor(d => {
            const name = d.properties.ADMIN;
            if (player.empire.includes(name)) return 'rgba(255, 255, 255, 0.8)';
            if (player.allies.includes(name)) return 'rgba(0, 242, 255, 0.3)';
            if (mergeSelection.includes(name)) return 'rgba(0, 242, 255, 0.6)';
            if (hoverCountry === d) return 'rgba(255, 255, 255, 0.2)';
            return 'rgba(0, 0, 0, 0.01)';
        })
        .polygonStrokeColor(() => 'rgba(255, 255, 255, 0.1)')
        .polygonLabel(d => createTooltip(d))
        .onPolygonHover(d => {
            hoverCountry = d;
            world.polygonCapColor(world.polygonCapColor());
        })
        .onPolygonClick(d => handlePolygonClick(d))
        .onPolygonRightClick((d, e) => showCtxMenu(d, e));

    world.controls().autoRotate = true;
    world.controls().autoRotateSpeed = 0.5;

    // Attach global listeners for UI
    window.initializeGame = startDeployment;
    window.handleAction = executeAction;
    
    document.getElementById('btn-draw').onclick = toggleBuildMode;
    document.getElementById('btn-merge').onclick = toggleMergeMode;
}

function createTooltip(d) {
    const p = d.properties;
    const stats = p.gameStats;
    const isOwned = player.empire.includes(p.ADMIN);
    
    return `
        <div class="tactical-tooltip">
            <div class="tt-header">${p.ADMIN}</div>
            <div class="tt-row"><span>Population</span> <span class="tt-val">${isOwned ? formatNum(stats.pop) : getFuzzy(stats.pop)}</span></div>
            <div class="tt-row"><span>Military</span> <span class="tt-val">${isOwned ? formatNum(stats.mil) : getFuzzy(stats.mil)}</span></div>
            <div class="tt-row"><span>Economy</span> <span class="tt-val">${isOwned ? formatNum(stats.econ) : getFuzzy(stats.econ, true)}</span></div>
        </div>
    `;
}

function handlePolygonClick(d) {
    if (!player.active) return;
    
    if (isMergeMode) {
        const name = d.properties.ADMIN;
        if (mergeSelection.includes(name)) {
            mergeSelection = mergeSelection.filter(n => n !== name);
        } else {
            mergeSelection.push(name);
        }
        world.polygonCapColor(world.polygonCapColor());
        return;
    }

    if (!isBuildMode && !player.empire.includes(d.properties.ADMIN)) {
        initiateInvasion(d);
    }
}

function showCtxMenu(d, e) {
    if (!player.active || isBuildMode) return;
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

    if (type === 'invade') initiateInvasion(target);
    if (type === 'ally') {
        player.allies.push(target.properties.ADMIN);
        logMsg(`Establish Link: ${target.properties.ADMIN}`);
        updateUI();
    }
    if (type === 'nuke') launchStrike(target);
}

function startDeployment() {
    const query = document.getElementById('start-country').value.trim().toLowerCase();
    const startNode = mapData.find(f => 
        f.properties.ADMIN.toLowerCase() === query || 
        f.properties.ADM0_A3.toLowerCase() === query
    );

    if (!startNode) return alert("Location unknown. Verify coordinates.");

    player.active = true;
    player.empire = [startNode.properties.ADMIN];
    player.stats = { ...startNode.properties.gameStats };

    document.getElementById('setup-screen').style.display = 'none';
    document.getElementById('status-bar').style.display = 'flex';
    document.getElementById('controls').style.display = 'flex';
    
    world.controls().autoRotate = false;
    const centroid = getCentroid(startNode);
    world.pointOfView({ lat: centroid[1], lng: centroid[0], altitude: 1.5 }, 2000);

    updateUI();
    logMsg(`Command Established: ${startNode.properties.ADMIN}`);
}

function updateUI() {
    document.getElementById('val-empire').innerText = player.empire[0] || 'N/A';
    document.getElementById('val-terr').innerText = player.empire.length;
    document.getElementById('val-pop').innerText = formatNum(player.stats.pop);
    document.getElementById('val-mil').innerText = formatNum(player.stats.mil);
    document.getElementById('val-econ').innerText = '$' + formatNum(player.stats.econ);
    world.polygonsData(mapData);
}

function logMsg(msg) {
    const log = document.getElementById('combat-log');
    log.innerText = `SYS // ${msg.toUpperCase()}`;
}

// Combat Logic
function initiateInvasion(target) {
    if (isFighting) return;
    const name = target.properties.ADMIN;
    isFighting = true;
    logMsg(`Invasion Initialized: ${name}`);

    let progress = 0;
    const interval = setInterval(() => {
        progress += 5;
        player.stats.mil -= Math.floor(target.properties.gameStats.mil * 0.05);
        if (progress >= 100) {
            clearInterval(interval);
            isFighting = false;
            player.empire.push(name);
            player.stats.pop += target.properties.gameStats.pop;
            player.stats.econ += target.properties.gameStats.econ;
            logMsg(`Sektor Annexed: ${name}`);
            updateUI();
        }
    }, 200);
}

function launchStrike(target) {
    const centroid = getCentroid(target);
    const startNode = mapData.find(f => f.properties.ADMIN === player.empire[0]);
    const startCentroid = getCentroid(startNode);

    activeArcs.push({
        startLat: startCentroid[1], startLng: startCentroid[0],
        endLat: centroid[1], endLng: centroid[0],
        color: ['#ffffff', '#ff3344']
    });
    world.arcsData(activeArcs);

    setTimeout(() => {
        activeArcs = []; world.arcsData([]);
        activeRings.push({ lat: centroid[1], lng: centroid[0], maxR: 15, speed: 5, repeat: 0, color: '#ff3344' });
        world.ringsData(activeRings);
        
        target.properties.gameStats.pop = Math.floor(target.properties.gameStats.pop * 0.1);
        target.properties.gameStats.mil = Math.floor(target.properties.gameStats.mil * 0.1);
        logMsg(`Strike Confirmed: ${target.properties.ADMIN}`);
        
        setTimeout(() => { activeRings = []; world.ringsData([]); }, 2000);
    }, 1000);
}

// Build & Merge Modes
function toggleMergeMode() {
    isMergeMode = !isMergeMode;
    const btn = document.getElementById('btn-merge');
    if (isMergeMode) {
        btn.classList.add('active');
        mergeSelection = [];
        logMsg("Merge Mode: Select sectors to combine");
    } else {
        btn.classList.remove('active');
        if (mergeSelection.length > 1) {
            const newName = prompt("Designate combined sector name:");
            if (newName) {
                const features = mapData.filter(f => mergeSelection.includes(f.properties.ADMIN));
                const merged = mergeCountries(features, newName);
                mapData = mapData.filter(f => !mergeSelection.includes(f.properties.ADMIN));
                mapData.push(merged);
                if (mergeSelection.some(n => player.empire.includes(n))) {
                    player.empire = player.empire.filter(n => !mergeSelection.includes(n));
                    player.empire.push(newName);
                }
                updateUI();
            }
        }
        mergeSelection = [];
    }
}

function toggleBuildMode() {
    isBuildMode = !isBuildMode;
    const btn = document.getElementById('btn-draw');
    if (isBuildMode) {
        btn.classList.add('active');
        drawnPoints = [];
        logMsg("Build Mode: Plot boundary points");
        world.onGlobeClick(coords => {
            let point = [coords.lng, coords.lat];
            // Auto Coast logic
            const coastlines = { type: 'FeatureCollection', features: mapData };
            point = snapToCoast({ type: 'Point', coordinates: point }, coastlines);
            
            drawnPoints.push(point);
            world.pathsData([{ coords: drawnPoints.map(p => [p[1], p[0]]) }]);
        });
    } else {
        btn.classList.remove('active');
        if (drawnPoints.length > 2) {
            const newName = prompt("Enter custom territory name:");
            if (newName) {
                const custom = {
                    type: 'Feature',
                    properties: {
                        ADMIN: newName,
                        gameStats: { pop: 1000000, mil: 10000, econ: 100000000 }
                    },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[...drawnPoints, drawnPoints[0]]]
                    }
                };
                mapData.push(custom);
                updateUI();
            }
        }
        world.onGlobeClick(null);
        world.pathsData([]);
    }
}

// Initial boot
init();
