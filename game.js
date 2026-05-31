import { formatNum, getCentroid } from './utils.js';
import * as THREE from 'three';
import Globe from 'globe.gl';


let sunGroup;
let sunLight;
let starField;
let jupiterGroup;
let saturnGroup;
let marsGroup;

let world;
let mapData = [];
let originalMapData = [];

let player = { active: false, empireName: '', stats: { pop: 0, mil: 0 } };
let hoverCountry = null;
let activeArcs = [];
let activeRings = [];
let invasionProgress = {};
let resolution = localStorage.getItem('geo_res') || 'high';

let socket = null;
let profile = null;
let lastCtxTarget = null;

let playerId = localStorage.getItem('geo_player_id');
if (!playerId) {
    playerId = 'usr_' + Math.random().toString(36).substring(2, 15);
    localStorage.setItem('geo_player_id', playerId);
}

const GEO_URL = './map.geojson';

window.requestSpawn = requestSpawn;
window.upgradeSkill = upgradeSkill;
window.handleContextAction = handleContextAction;
window.requestSelfCollapse = requestSelfCollapse;
window.closeCollapseModal = () => { document.getElementById('collapse-screen').style.display = 'none'; };
window.closeVictoryModal = () => { document.getElementById('victory-screen').style.display = 'none'; };

window.showSettingsModal = () => {
    document.getElementById('settings-screen').style.display = 'flex';
    const currentRes = localStorage.getItem('geo_res') || 'high';
    document.getElementById('res-high').classList.toggle('active', currentRes === 'high');
    document.getElementById('res-low').classList.toggle('active', currentRes === 'low');
    document.getElementById('ws-endpoint-input').value = localStorage.getItem('geo_ws_endpoint') || '';
};

window.closeSettingsModal = () => {
    const inputVal = document.getElementById('ws-endpoint-input').value.trim();
    const oldEndpoint = localStorage.getItem('geo_ws_endpoint') || '';
    localStorage.setItem('geo_ws_endpoint', inputVal);
    document.getElementById('settings-screen').style.display = 'none';
    if (inputVal !== oldEndpoint) {
        if (socket) {
            socket.close();
        }
    }
};

window.setResolution = (res) => {
    resolution = res;
    localStorage.setItem('geo_res', res);
    document.getElementById('res-high').classList.toggle('active', res === 'high');
    document.getElementById('res-low').classList.toggle('active', res === 'low');
    if (res === 'low') {
        activeArcs = [];
        if (world) {
            world.arcsData([]);
        }
    }
};


async function init() {
    try {
        const res = await fetch(GEO_URL);
        if (!res.ok) throw new Error('HTTP error');
        const data = await res.json();
        originalMapData = data.features.map(f => {
            const p = f.properties;
            const pop = p.POP_EST || 1000000;
            f.properties.owner = p.ADMIN;
            f.properties.gameStats = { pop: pop, mil: Math.floor(pop * 0.01) };
            return f;
        });
        mapData = JSON.parse(JSON.stringify(originalMapData));

        setupWorld();
        setupTabs();
        setupSearch();
        setupContextHandlers();
        connectWebSocket();
    } catch (err) {
        console.error('Init failure', err);
    }
}

function getOwnerColor(ownerName) {
    if (!ownerName) return '#fff';
    if (profile && ownerName === profile.username) return profile.selectedColor;
    if (mapData) {
        const country = mapData.find(f => f.properties.ADMIN === ownerName);
        if (country && country.properties.color) return country.properties.color;
    }
    return `hsl(${Math.abs(ownerName.charCodeAt(0) * 20) % 360}, 70%, 50%)`;
}

function hexToRgb(hex) {
    if (!hex) return '255,255,255';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${r}, ${g}, ${b}`;
}

function setupWorld() {
    if (!Globe) return;

    world = Globe()(document.getElementById('globe-container'))
        .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
        .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
        .backgroundColor('#000000')
        .showAtmosphere(true)
        .atmosphereColor('#ffffff')
        .atmosphereAltitude(0.12)
        .polygonsData(mapData)
        .polygonCapColor(d => {
            const owner = d.properties.owner || d.properties.ADMIN;
            const ownerColor = getOwnerColor(owner);
            const progs = invasionProgress[d.properties.ADMIN];
            if (progs && progs.length > 0) {
                const primary = progs.sort((a, b) => b.val - a.val)[0];
                const primaryColor = getOwnerColor(primary.attacker);
                return `rgba(${hexToRgb(primaryColor)}, ${primary.val})`;
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
    world.controls().autoRotateSpeed = 0.3;
    world.pointOfView({ lat: 20, lng: 0, altitude: 2.5 });

    sunLight = new THREE.DirectionalLight(0xfff5ea, 1.2);
    world.scene().add(sunLight);

    const starGeo = new THREE.BufferGeometry();
    const starCoords = [];
    for (let i = 0; i < 2000; i++) {
        const x = (Math.random() - 0.5) * 4000;
        const y = (Math.random() - 0.5) * 4000;
        const z = (Math.random() - 0.5) * 4000;
        const dist = Math.sqrt(x * x + y * y + z * z);
        if (dist < 1000) {
            i--;
            continue;
        }
        starCoords.push(x, y, z);
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starCoords, 3));
    const starMat = new THREE.PointsMaterial({
        color: 0xffffff,
        size: 1.5,
        transparent: true,
        opacity: 0.8,
        sizeAttenuation: true
    });
    starField = new THREE.Points(starGeo, starMat);
    world.scene().add(starField);

    sunGroup = new THREE.Group();
    const sunGeo = new THREE.SphereGeometry(45, 32, 32);
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xffeaad, toneMapped: false });
    const sunMesh = new THREE.Mesh(sunGeo, sunMat);
    sunGroup.add(sunMesh);

    const glowGeo = new THREE.SphereGeometry(52, 32, 32);
    const glowMat = new THREE.MeshBasicMaterial({
        color: 0xff8800,
        transparent: true,
        opacity: 0.25,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide
    });
    const glowMesh = new THREE.Mesh(glowGeo, glowMat);
    sunGroup.add(glowMesh);
    world.scene().add(sunGroup);

    jupiterGroup = new THREE.Group();
    const jupiterGeo = new THREE.SphereGeometry(25, 32, 32);
    const jupiterMat = new THREE.MeshPhongMaterial({ color: 0xd4a373, shininess: 5 });
    const jupiterMesh = new THREE.Mesh(jupiterGeo, jupiterMat);
    jupiterGroup.add(jupiterMesh);
    jupiterGroup.position.set(-800, 150, -800);
    world.scene().add(jupiterGroup);

    saturnGroup = new THREE.Group();
    const saturnGeo = new THREE.SphereGeometry(18, 32, 32);
    const saturnMat = new THREE.MeshPhongMaterial({ color: 0xe9d8a6, shininess: 5 });
    const saturnMesh = new THREE.Mesh(saturnGeo, saturnMat);
    saturnGroup.add(saturnMesh);

    const ringGeo = new THREE.RingGeometry(24, 38, 64);
    ringGeo.rotateX(Math.PI / 2.5);
    const ringMat = new THREE.MeshBasicMaterial({
        color: 0x94d2bd,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.3
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    saturnGroup.add(ringMesh);
    saturnGroup.position.set(900, -200, -600);
    world.scene().add(saturnGroup);

    marsGroup = new THREE.Group();
    const marsGeo = new THREE.SphereGeometry(10, 32, 32);
    const marsMat = new THREE.MeshPhongMaterial({ color: 0xc67b5c, shininess: 2 });
    const marsMesh = new THREE.Mesh(marsGeo, marsMat);
    marsGroup.add(marsMesh);
    marsGroup.position.set(-400, -100, 800);
    world.scene().add(marsGroup);

    const orbitMaterial = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.03
    });
    const createOrbit = (radius) => {
        const points = [];
        for (let i = 0; i <= 64; i++) {
            const theta = (i / 64) * Math.PI * 2;
            points.push(new THREE.Vector3(radius * Math.cos(theta), 0, radius * Math.sin(theta)));
        }
        const orbitGeo = new THREE.BufferGeometry().setFromPoints(points);
        const orbitLine = new THREE.Line(orbitGeo, orbitMaterial);
        orbitLine.rotation.x = 0.15;
        return orbitLine;
    };
    world.scene().add(createOrbit(600));
    world.scene().add(createOrbit(1000));
    world.scene().add(createOrbit(1300));

    animate();
}

function animate() {
    requestAnimationFrame(animate);
    const time = Date.now() * 0.0001;
    const x = 1200 * Math.cos(time);
    const z = 1200 * Math.sin(time);
    if (sunGroup) sunGroup.position.set(x, 200, z);
    if (sunLight) sunLight.position.set(x, 200, z);
    if (starField) {
        starField.rotation.y += 0.00008;
        starField.rotation.x += 0.00004;
    }
    if (jupiterGroup) jupiterGroup.rotation.y += 0.002;
    if (saturnGroup) saturnGroup.rotation.y += 0.003;
    if (marsGroup) marsGroup.rotation.y += 0.004;
}

function connectWebSocket() {
    let wsUrl = localStorage.getItem('geo_ws_endpoint');
    if (!wsUrl) {
        wsUrl = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
            ? 'ws://localhost:8080'
            : 'wss://api.geopolitics-game.org';
    }

    console.log("Connecting to command grid at:", wsUrl);
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        const statusEl = document.getElementById('connection-status');
        if (statusEl) {
            statusEl.className = 'status-indicator online';
            statusEl.querySelector('.status-text').innerText = 'LIVE';
        }
        socket.send(JSON.stringify({
            type: 'REGISTER',
            playerId: playerId,
            username: localStorage.getItem('geo_player_name') || ''
        }));
    };

    socket.onclose = () => {
        const statusEl = document.getElementById('connection-status');
        if (statusEl) {
            statusEl.className = 'status-indicator offline';
            statusEl.querySelector('.status-text').innerText = 'OFFLINE';
        }
        setTimeout(connectWebSocket, 3000);
    };

    socket.onerror = () => {
        socket.close();
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleServerMessage(data);
        } catch (e) {
            console.error('WS parse error', e);
        }
    };
}

function handleServerMessage(data) {
    const { type } = data;

    if (type === 'WELCOME') {
        profile = data.profile;
        document.getElementById('player-tokens-val').innerText = profile.tokens;
        
        if (data.mapState) {
            applyMapState(data.mapState);
        }
        if (data.leaderboard) {
            updateLeaderboardUI(data.leaderboard);
        }
        updateCommandHubUI();
        return;
    }

    if (type === 'MAP_INITIAL') {
        applyMapState(data.mapState);
        return;
    }

    if (type === 'MAP_UPDATE') {
        data.updates.forEach(u => {
            const feature = mapData.find(f => f.properties.ADMIN === u.admin);
            if (feature) {
                feature.properties.owner = u.owner;
                feature.properties.gameStats.pop = u.pop;
                feature.properties.gameStats.mil = u.mil;
                feature.properties.color = u.color;
            }
        });
        if (world) world.polygonsData(mapData);
        updateActiveHUD();
        return;
    }

    if (type === 'INVASION_START') {
        const { attacker, target, invadeType, duration, startCoords, endCoords, color } = data;
        if (resolution === 'high' && startCoords && endCoords) {
            const arc = {
                startLat: startCoords[1], startLng: startCoords[0],
                endLat: endCoords[1], endLng: endCoords[0],
                color: color ? [color, '#ffffff'] : ['#888888', '#ffffff']
            };
            activeArcs.push(arc);
            if (world) world.arcsData(activeArcs);

            setTimeout(() => {
                activeArcs = activeArcs.filter(a => a !== arc);
                if (world) world.arcsData(activeArcs);
            }, duration);
        }

        const start = Date.now();
        const anim = () => {
            const elapsed = Date.now() - start;
            const prog = Math.min(1, elapsed / duration);
            if (!invasionProgress[target]) invasionProgress[target] = [];
            let progState = invasionProgress[target].find(p => p.attacker === attacker);
            if (!progState) {
                progState = { attacker, val: 0 };
                invasionProgress[target].push(progState);
            }
            progState.val = prog;

            if (world) world.polygonCapColor(world.polygonCapColor());

            if (prog < 1 && invasionProgress[target].includes(progState)) {
                requestAnimationFrame(anim);
            } else {
                invasionProgress[target] = invasionProgress[target].filter(p => p !== progState);
                if (world) world.polygonCapColor(world.polygonCapColor());
            }
        };
        anim();
        return;
    }

    if (type === 'NUKE_LAUNCH') {
        const { attacker, target, startCoords, endCoords } = data;
        if (resolution === 'high' && startCoords && endCoords) {
            const arc = {
                startLat: startCoords[1], startLng: startCoords[0],
                endLat: endCoords[1], endLng: endCoords[0],
                color: ['#ffff00', '#ee0000']
            };
            activeArcs.push(arc);
            if (world) world.arcsData(activeArcs);

            setTimeout(() => {
                activeArcs = activeArcs.filter(a => a !== arc);
                if (world) world.arcsData(activeArcs);



                document.body.classList.add('shake');
                activeRings.push({ lat: endCoords[1], lng: endCoords[0], maxR: 25, speed: 6, repeat: 0, color: '#ee0000' });
                if (world) world.ringsData(activeRings);

                setTimeout(() => {
                    activeRings = [];
                    if (world) world.ringsData([]);
                    document.body.classList.remove('shake');
                }, 1000);

            }, 1000);
        }
        return;
    }

    if (type === 'LEADERBOARD_UPDATE') {
        updateLeaderboardUI(data.leaderboard);
        return;
    }

    if (type === 'LOG') {
        logMsg(data.message);
        return;
    }

    if (type === 'SPAWN_SUCCESS') {
        player.active = true;
        player.empireName = profile.username;

        document.getElementById('dashboard-overlay').style.display = 'none';
        document.getElementById('saas-header').style.display = 'none';
        document.getElementById('active-hud').style.display = 'block';

        if (world) world.controls().autoRotate = false;

        const targetNode = mapData.find(f => f.properties.ADMIN === data.country);
        if (targetNode) {
            const centroid = getCentroid(targetNode);
            if (world) world.pointOfView({ lat: centroid[1], lng: centroid[0], altitude: 1.2 }, 2000);
        }

        updateActiveHUD();
        return;
    }

    if (type === 'COLLAPSE') {
        player.active = false;
        document.getElementById('active-hud').style.display = 'none';
        document.getElementById('saas-header').style.display = 'flex';
        document.getElementById('dashboard-overlay').style.display = 'flex';

        if (world) {
            world.controls().autoRotate = true;
            world.pointOfView({ lat: 20, lng: 0, altitude: 2.5 }, 1000);
        }

        document.getElementById('collapse-sectors').innerText = data.stats.territories;
        document.getElementById('collapse-peak').innerText = formatNum(data.stats.peakMil);
        document.getElementById('collapse-tokens').innerText = `+${data.tokensAwarded} TOKENS`;
        document.getElementById('collapse-screen').style.display = 'flex';
        return;
    }

    if (type === 'VICTORY') {
        player.active = false;
        document.getElementById('active-hud').style.display = 'none';
        document.getElementById('saas-header').style.display = 'flex';
        document.getElementById('dashboard-overlay').style.display = 'flex';

        if (world) {
            world.controls().autoRotate = true;
            world.pointOfView({ lat: 20, lng: 0, altitude: 2.5 }, 1000);
        }

        document.getElementById('victory-tokens').innerText = `+${data.bonusTokens} TOKENS`;
        document.getElementById('victory-screen').style.display = 'flex';
        return;
    }

    if (type === 'ERROR') {
        alert(data.message);
        return;
    }
}

function applyMapState(state) {
    state.forEach(s => {
        const feature = mapData.find(f => f.properties.ADMIN === s.admin);
        if (feature) {
            feature.properties.owner = s.owner;
            feature.properties.gameStats = { pop: s.pop, mil: s.mil };
            feature.properties.color = s.color;
        }
    });
    if (world) world.polygonsData(mapData);
}

function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            const tabId = btn.getAttribute('data-tab');
            document.getElementById(`tab-${tabId}`).classList.add('active');
        });
    });
}

function setupSearch() {
    const searchInput = document.getElementById('start-country');
    const resultsDiv = document.getElementById('search-results');

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const val = e.target.value.toLowerCase();
            const matches = mapData.filter(f =>
                f.properties.ADMIN.toLowerCase().includes(val) ||
                (f.properties.ADM0_A3 && f.properties.ADM0_A3.toLowerCase().includes(val))
            ).slice(0, 8);

            if (!val) {
                resultsDiv.style.display = 'none';
                return;
            }
            resultsDiv.innerHTML = matches.map(m => `<div class="search-item" data-name="${m.properties.ADMIN}">${m.properties.ADMIN}</div>`).join('');
            resultsDiv.style.display = 'block';

            document.querySelectorAll('.search-item').forEach(item => {
                item.addEventListener('click', (ev) => {
                    searchInput.value = ev.target.getAttribute('data-name');
                    resultsDiv.style.display = 'none';
                    const targetNode = mapData.find(f => f.properties.ADMIN === searchInput.value);
                    if (targetNode && world) {
                        const centroid = getCentroid(targetNode);
                        world.pointOfView({ lat: centroid[1], lng: centroid[0], altitude: 1.2 }, 1200);
                    }
                });
            });
        });
    }

    document.addEventListener('click', (e) => {
        if (resultsDiv && e.target !== searchInput && e.target !== resultsDiv) {
            resultsDiv.style.display = 'none';
        }
    });
}

function requestSpawn() {
    const query = document.getElementById('start-country').value.trim();
    if (!query) return alert('Select target sector.');

    let finalName = localStorage.getItem('geo_player_name');
    if (!finalName) {
        finalName = prompt('Enter Empire Identifier Name:') || 'Commander';
        localStorage.setItem('geo_player_name', finalName);
    }

    if (socket && socket.readyState === 1) {
        socket.send(JSON.stringify({
            type: 'SPAWN',
            country: query
        }));
    }
}

function requestSelfCollapse() {
    if (!confirm('Execute operational abandonment sequence?')) return;
    if (socket && socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'ABANDON' }));
    }
}

function upgradeSkill(skill) {
    if (socket && socket.readyState === 1) {
        socket.send(JSON.stringify({
            type: 'UPGRADE_SKILL',
            skill
        }));
    }
}

function selectColor(color) {
    if (socket && socket.readyState === 1) {
        socket.send(JSON.stringify({
            type: 'SELECT_COLOR',
            color
        }));
    }
}

function handlePolygonClick(d) {
    if (!player.active) {
        const searchInput = document.getElementById('start-country');
        if (searchInput) {
            searchInput.value = d.properties.ADMIN;
            const centroid = getCentroid(d);
            if (world) world.pointOfView({ lat: centroid[1], lng: centroid[0], altitude: 1.2 }, 1200);
        }
        return;
    }

    if (d.properties.owner === profile.username) return;

    if (socket && socket.readyState === 1) {
        socket.send(JSON.stringify({
            type: 'INVADE',
            target: d.properties.ADMIN
        }));
    }
}

function showCtxMenu(d, e) {
    if (!player.active) return;
    if (d.properties.owner === profile.username) return;

    const menu = document.getElementById('ctx-menu');
    if (menu) {
        menu.style.display = 'block';
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        lastCtxTarget = d;
    }
}

function setupContextHandlers() {
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('ctx-menu');
        if (menu && e.button !== 2) {
            menu.style.display = 'none';
        }
    });
}

function handleContextAction(action) {
    const target = lastCtxTarget;
    const menu = document.getElementById('ctx-menu');
    if (menu) menu.style.display = 'none';

    if (!target) return;

    if (action === 'invade') {
        handlePolygonClick(target);
    } else if (action === 'nuke') {
        if (socket && socket.readyState === 1) {
            socket.send(JSON.stringify({
                type: 'NUKE',
                target: target.properties.ADMIN
            }));
        }
    }
}

function updateActiveHUD() {
    if (!player.active || !profile) return;
    const playerLands = mapData.filter(f => f.properties.owner === profile.username);
    const totalPop = playerLands.reduce((sum, f) => sum + f.properties.gameStats.pop, 0);
    const totalMil = playerLands.reduce((sum, f) => sum + f.properties.gameStats.mil, 0);

    document.getElementById('hud-empire').innerText = profile.username;
    document.getElementById('hud-sectors').innerText = playerLands.length;
    document.getElementById('hud-pop').innerText = formatNum(totalPop);
    document.getElementById('hud-mil').innerText = formatNum(totalMil);
}

function updateLeaderboardUI(leaderboard) {
    const { mapControl, globalLeaderboard } = leaderboard;

    const activeList = document.getElementById('active-control-list');
    const hudList = document.getElementById('active-map-control-list');

    const listHtml = mapControl.map((entry, idx) => `
        <div class="control-item ${profile && entry.name === profile.username ? 'player' : ''}">
            <span class="name">
                <span class="color-dot" style="background:${entry.color || '#888'}"></span>
                ${idx + 1}. ${entry.name}
            </span>
            <span class="stats">${entry.terr}S / ${formatNum(entry.mil)}M</span>
        </div>
    `).join('') || '<div class="list-empty">No active deployments detected.</div>';

    if (activeList) activeList.innerHTML = listHtml;
    if (hudList) hudList.innerHTML = listHtml;

    const tableBody = document.getElementById('leaderboard-table-body');
    if (tableBody) {
        if (globalLeaderboard.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="4" class="table-empty">No global control records indexed.</td></tr>';
        } else {
            tableBody.innerHTML = globalLeaderboard.map((playerRecord, idx) => `
                <tr>
                    <td class="rank-col">${idx + 1}</td>
                    <td class="username-col">${playerRecord.username}</td>
                    <td>${playerRecord.wins}</td>
                    <td>${playerRecord.tokens}</td>
                </tr>
            `).join('');
        }
    }
}

function updateCommandHubUI() {
    if (!profile) return;

    const skills = [
        { id: 'logistics', base: '0.3%', factor: 0.1, suffix: '% / sec', step: 0.001, costs: [10, 25, 50] },
        { id: 'tacticalParity', base: '2.5x', factor: -0.2, suffix: 'x threshold', step: -0.2, costs: [15, 30, 60] },
        { id: 'economicHeadstart', base: 'Base', factor: 5, suffix: '% Capacity', step: 0.05, costs: [12, 25, 50] }
    ];

    skills.forEach(s => {
        const lvl = profile.skills[s.id] || 0;
        const currentSpan = document.getElementById(s.id === 'logistics' ? 'skill-logistics-current' : (s.id === 'tacticalParity' ? 'skill-parity-current' : 'skill-econ-current'));
        const nextSpan = document.getElementById(s.id === 'logistics' ? 'skill-logistics-next' : (s.id === 'tacticalParity' ? 'skill-parity-next' : 'skill-econ-next'));
        const costSpan = document.getElementById(s.id === 'logistics' ? 'cost-logistics' : (s.id === 'tacticalParity' ? 'cost-parity' : 'cost-econ'));
        const indicators = document.getElementById(s.id === 'logistics' ? 'level-logistics' : (s.id === 'tacticalParity' ? 'level-parity' : 'level-econ')).children;

        for (let i = 0; i < indicators.length; i++) {
            indicators[i].className = i < lvl ? 'bar active' : 'bar';
        }

        if (s.id === 'logistics') {
            const curVal = 0.003 + lvl * 0.001;
            const nextVal = 0.003 + (lvl + 1) * 0.001;
            currentSpan.innerText = `${(curVal * 100).toFixed(1)}% / sec`;
            nextSpan.innerText = lvl < 3 ? `${(nextVal * 100).toFixed(1)}% / sec` : 'MAX';
        } else if (s.id === 'tacticalParity') {
            const curVal = 2.5 - lvl * 0.2;
            const nextVal = 2.5 - (lvl + 1) * 0.2;
            currentSpan.innerText = `${curVal.toFixed(1)}x threshold`;
            nextSpan.innerText = lvl < 3 ? `${nextVal.toFixed(1)}x threshold` : 'MAX';
        } else {
            currentSpan.innerText = lvl === 0 ? 'Base Capacity' : `+${(lvl * 5)}% Capacity`;
            nextSpan.innerText = lvl < 3 ? `+${((lvl + 1) * 5)}% Capacity` : 'MAX';
        }

        const cost = s.costs[lvl];
        const btn = costSpan.parentElement;

        if (lvl >= 3) {
            costSpan.innerText = 'MAX';
            btn.disabled = true;
        } else {
            costSpan.innerText = `${cost} TKN`;
            btn.disabled = profile.tokens < cost;
        }
    });

    const achievements = [
        { id: 'ach-clean', color: '#ffd700', completed: profile.unlockedColors.includes('#ffd700') },
        { id: 'ach-conq', color: '#800080', completed: profile.unlockedColors.includes('#800080') },
        { id: 'ach-goliath', color: '#39ff14', completed: profile.unlockedColors.includes('#39ff14') },
        { id: 'ach-surv', color: '#8b0000', completed: profile.unlockedColors.includes('#8b0000') }
    ];

    achievements.forEach(ach => {
        const el = document.getElementById(ach.id);
        if (el) {
            el.className = ach.completed ? 'achievement-item unlocked' : 'achievement-item';
        }
    });

    const pickerGrid = document.getElementById('faction-color-picker');
    if (pickerGrid) {
        const colorPalette = [
            { hex: '#0070f3', id: 'default', req: null },
            { hex: '#ffd700', id: 'clean', req: '#ffd700' },
            { hex: '#800080', id: 'conq', req: '#800080' },
            { hex: '#39ff14', id: 'goliath', req: '#39ff14' },
            { hex: '#8b0000', id: 'surv', req: '#8b0000' }
        ];

        pickerGrid.innerHTML = colorPalette.map(c => {
            const isUnlocked = c.req === null || profile.unlockedColors.includes(c.req);
            const isSelected = profile.selectedColor === c.hex;

            if (isUnlocked) {
                return `<div class="color-box ${isSelected ? 'selected' : ''}" style="background:${c.hex}" data-hex="${c.hex}"></div>`;
            } else {
                return `<div class="color-box locked" style="background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1)"></div>`;
            }
        }).join('');

        pickerGrid.querySelectorAll('.color-box:not(.locked)').forEach(box => {
            box.addEventListener('click', (e) => {
                selectColor(e.target.getAttribute('data-hex'));
            });
        });
    }
}

function createTooltip(d) {
    if (!profile) return '';
    const p = d.properties;
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

function logMsg(msg) {
    const log = document.getElementById('combat-log');
    if (log) log.innerText = msg.toUpperCase();
}

init();
