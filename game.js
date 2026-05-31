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

let profile = null;
let lastCtxTarget = null;
let processedEventIds = new Set();
let pollInterval = null;
let isInitComplete = false;

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
    document.getElementById('ws-endpoint-input').value = 'Vercel Serverless Server';
    document.getElementById('ws-endpoint-input').disabled = true;
};

window.closeSettingsModal = () => {
    document.getElementById('settings-screen').style.display = 'none';
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

function initSupabase() {
    const url = 'https://epnjfsfveqbvoimpstbd.supabase.co';
    const key = 'sb_publishable_12ymAaNfKTNDknIvcDVdEQ_l7P8jfdr';
    const storage = {
        getItem(k) {
            try {
                const v = window.localStorage.getItem(k);
                if (v) return v;
            } catch (e) {}
            const name = k + "=";
            const ca = document.cookie.split(';');
            for (let i = 0; i < ca.length; i++) {
                let c = ca[i].trim();
                if (c.indexOf(name) === 0) {
                    try {
                        const raw = decodeURIComponent(c.substring(name.length));
                        const parsed = JSON.parse(raw);
                        if (parsed.access_token) {
                            return JSON.stringify({
                                access_token: parsed.access_token,
                                refresh_token: parsed.refresh_token,
                                expires_at: parsed.expires_at,
                                token_type: "bearer",
                                user: parsed.user || {}
                            });
                        }
                    } catch (e) {}
                }
            }
            return null;
        },
        setItem(k, v) {
            try {
                window.localStorage.setItem(k, v);
            } catch (e) {}
            try {
                const parsed = JSON.parse(v);
                if (parsed.access_token) {
                    const compact = JSON.stringify({
                        access_token: parsed.access_token,
                        refresh_token: parsed.refresh_token,
                        expires_at: parsed.expires_at,
                        user: parsed.user ? { id: parsed.user.id, email: parsed.user.email } : {}
                    });
                    const d = new Date();
                    d.setTime(d.getTime() + (365 * 24 * 60 * 60 * 1000));
                    const exp = "expires=" + d.toUTCString();
                    let dom = "";
                    if (window.location.hostname.endsWith("things-and-shit.org")) {
                        dom = ";domain=.things-and-shit.org";
                    } else if (window.location.hostname.endsWith("geopolitics-game.org")) {
                        dom = ";domain=.geopolitics-game.org";
                    }
                    const sec = window.location.protocol === 'https:' ? ';Secure' : '';
                    document.cookie = k + "=" + encodeURIComponent(compact) + ";" + exp + ";path=/" + dom + ";SameSite=Lax" + sec;
                }
            } catch (e) {}
        },
        removeItem(k) {
            try {
                window.localStorage.removeItem(k);
            } catch (e) {}
            let dom = "";
            if (window.location.hostname.endsWith("things-and-shit.org")) {
                dom = ";domain=.things-and-shit.org";
            } else if (window.location.hostname.endsWith("geopolitics-game.org")) {
                dom = ";domain=.geopolitics-game.org";
            }
            document.cookie = k + "=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/" + dom;
        }
    };

    if (window.supabase) {
        window.supabase = window.supabase.createClient(url, key, {
            auth: {
                storage: storage,
                autoRefreshToken: true,
                persistSession: true
            }
        });

        window.supabase.auth.onAuthStateChange((event, session) => {
            let nextPlayerId = playerId;
            if (session && session.user) {
                nextPlayerId = session.user.id;
            } else {
                let anonPlayerId = localStorage.getItem('geo_player_id');
                if (!anonPlayerId) {
                    anonPlayerId = 'usr_' + Math.random().toString(36).substring(2, 15);
                    localStorage.setItem('geo_player_id', anonPlayerId);
                }
                nextPlayerId = anonPlayerId;
            }
            if (playerId !== nextPlayerId) {
                playerId = nextPlayerId;
                if (isInitComplete) {
                    connectBackend();
                }
            }
            updateAuthUI(session);
            const authEvent = new CustomEvent('supabaseAuthChange', { detail: { session } });
            window.dispatchEvent(authEvent);
        });
    }
}

window.showAuthModal = () => {
    document.getElementById('auth-screen').style.display = 'flex';
};

window.closeAuthModal = () => {
    document.getElementById('auth-screen').style.display = 'none';
};

window.loginGoogle = async () => {
    const fromUrl = window.location.href.split('#')[0];
    const routerUrl = 'https://things-and-shit.org/redirect.html?action=google&from=' + encodeURIComponent(fromUrl);
    window.location.href = routerUrl;
};

window.loginEmailPrompt = async () => {
    const email = prompt("Enter your email:");
    if (email) {
        const fromUrl = window.location.href.split('#')[0];
        const routerUrl = 'https://things-and-shit.org/redirect.html?action=email&email=' + encodeURIComponent(email) + '&from=' + encodeURIComponent(fromUrl);
        window.location.href = routerUrl;
    }
};

window.logoutSupabase = async () => {
    if (!window.supabase) return;
    await window.supabase.auth.signOut();
    localStorage.removeItem('geo_player_id');
    localStorage.removeItem('geo_player_name');
    window.location.reload();
};

window.saveAuthUsername = async () => {
    const input = document.getElementById('auth-username-input');
    if (input) {
        let name = input.value.trim();
        if (name) {
            localStorage.setItem('geo_player_name', name);
            if (profile) {
                profile.username = name;
            }
            await connectBackend();
            window.closeAuthModal();
        } else {
            alert('Please enter a username.');
        }
    }
};

function updateAuthUI(session) {
    const authBtn = document.getElementById('auth-btn');
    const authBtnText = document.getElementById('auth-btn-text');
    const loggedOutState = document.getElementById('auth-logged-out-state');
    const loggedInState = document.getElementById('auth-logged-in-state');
    const userEmailEl = document.getElementById('auth-user-email');
    const usernameInput = document.getElementById('auth-username-input');

    if (session && session.user) {
        let name = localStorage.getItem('geo_player_name') || session.user.email.split('@')[0];
        if (profile && profile.username) {
            name = profile.username;
        }
        if (authBtnText) {
            authBtnText.innerText = name.toUpperCase();
        }
        if (loggedOutState) loggedOutState.style.display = 'none';
        if (loggedInState) loggedInState.style.display = 'block';
        if (userEmailEl) userEmailEl.innerText = session.user.email;
        if (usernameInput) {
            usernameInput.value = name;
        }
    } else {
        if (authBtnText) {
            authBtnText.innerText = 'SIGN IN';
        }
        if (loggedOutState) loggedOutState.style.display = 'block';
        if (loggedInState) loggedInState.style.display = 'none';
    }
}

async function init() {
    initSupabase();
    let isRedirect = false;
    if (window.location.hash.includes('access_token') || window.location.hash.includes('id_token')) {
        isRedirect = true;
    }
    if (window.supabase) {
        const { data } = await window.supabase.auth.getSession();
        if (data && data.session && data.session.user) {
            playerId = data.session.user.id;
        }
    }
    if (isRedirect) {
        history.replaceState(null, document.title, window.location.pathname + window.location.search);
        window.showAuthModal();
    }
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
        isInitComplete = true;
        connectBackend();
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

function hexToRgb(color) {
    if (!color) return '255,255,255';
    if (color.startsWith('hsl')) {
        const matches = color.match(/\d+/g);
        if (matches && matches.length >= 3) {
            const h = parseInt(matches[0]);
            const s = parseInt(matches[1]) / 100;
            const l = parseInt(matches[2]) / 100;
            const c = (1 - Math.abs(2 * l - 1)) * s;
            const x = c * (1 - Math.abs((h / 60) % 2 - 1));
            const m = l - c / 2;
            let r = 0, g = 0, b = 0;
            if (h >= 0 && h < 60) { r = c; g = x; b = 0; }
            else if (h >= 60 && h < 120) { r = x; g = c; b = 0; }
            else if (h >= 120 && h < 180) { r = 0; g = c; b = x; }
            else if (h >= 180 && h < 240) { r = 0; g = x; b = c; }
            else if (h >= 240 && h < 300) { r = x; g = 0; b = c; }
            else if (h >= 300 && h < 360) { r = c; g = 0; b = x; }
            return `${Math.round((r + m) * 255)}, ${Math.round((g + m) * 255)}, ${Math.round((b + m) * 255)}`;
        }
    }
    let hex = color;
    if (hex.startsWith('#')) {
        if (hex.length === 4) {
            hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
        }
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
            return `${r}, ${g}, ${b}`;
        }
    }
    return '255,255,255';
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
            if (hoverCountry === d) {
                if (ownerColor.startsWith('#')) {
                    let hex = ownerColor;
                    if (hex.length === 4) {
                        hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
                    }
                    return hex + 'cc';
                }
                if (ownerColor.startsWith('hsl')) {
                    return ownerColor.replace('hsl(', 'hsla(').replace(')', ', 0.8)');
                }
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

async function connectBackend() {
    if (pollInterval) clearInterval(pollInterval);
    try {
        let currentUsername = localStorage.getItem('geo_player_name') || '';
        if (!currentUsername && window.supabase) {
            const { data } = await window.supabase.auth.getSession();
            if (data && data.session && data.session.user) {
                currentUsername = data.session.user.email.split('@')[0];
            }
        }
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                playerId,
                username: currentUsername
            })
        });

        if (res.ok) {
            profile = await res.json();
            localStorage.setItem('geo_player_name', profile.username);

            const statusEl = document.getElementById('connection-status');
            if (statusEl) {
                statusEl.className = 'status-indicator online';
                statusEl.querySelector('.status-text').innerText = 'LIVE';
            }

            document.getElementById('player-tokens-val').innerText = profile.tokens;
            updateCommandHubUI();

            await pollMapState();
            pollInterval = setInterval(pollMapState, 2000);
        } else {
            throw new Error('Registration failed');
        }
    } catch (e) {
        console.error('Serverless connection error', e);
        const statusEl = document.getElementById('connection-status');
        if (statusEl) {
            statusEl.className = 'status-indicator offline';
            statusEl.querySelector('.status-text').innerText = 'OFFLINE';
        }
        setTimeout(connectBackend, 5000);
    }
}

async function pollMapState() {
    try {
        const res = await fetch(`/api/map?playerId=${playerId}`);
        if (!res.ok) return;

        const data = await res.json();
        if (data.welcomeProfile) {
            profile = data.welcomeProfile;
            document.getElementById('player-tokens-val').innerText = profile.tokens;
            updateCommandHubUI();
        }

        applyMapState(data.mapState);
        updateLeaderboardUI(data.leaderboard);
        processActiveEvents(data.activeEvents);
    } catch (e) {
        console.error('State poll error', e);
    }
}

function applyMapState(state) {
    state.forEach(s => {
        const feature = mapData.find(f => f.properties.ADMIN === s.admin);
        if (feature) {
            feature.properties.owner = s.owner;
            feature.properties.gameStats.pop = s.pop;
            feature.properties.gameStats.mil = s.mil;
            feature.properties.color = s.color;
        }
    });
    if (world) world.polygonsData(mapData);
    updateActiveHUD();
}

function processActiveEvents(events) {
    events.forEach(e => {
        if (processedEventIds.has(e.id)) return;
        processedEventIds.add(e.id);

        if (e.type === 'INVASION_START') {
            const { attacker, target, invadeType, duration, startCoords, endCoords, color } = e;
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
        } else if (e.type === 'NUKE_LAUNCH') {
            const { attacker, target, startCoords, endCoords, duration } = e;
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

                }, duration);
            }
        } else if (e.type === 'COLLAPSE') {
            if (e.playerId === playerId) {
                player.active = false;
                document.getElementById('active-hud').style.display = 'none';
                document.getElementById('saas-header').style.display = 'flex';
                document.getElementById('dashboard-overlay').style.display = 'flex';

                if (world) {
                    world.controls().autoRotate = true;
                    world.pointOfView({ lat: 20, lng: 0, altitude: 2.5 }, 1000);
                }

                document.getElementById('collapse-sectors').innerText = e.stats.territories;
                document.getElementById('collapse-peak').innerText = formatNum(e.stats.peakMil);
                document.getElementById('collapse-tokens').innerText = `+${e.tokensAwarded} TOKENS`;
                document.getElementById('collapse-screen').style.display = 'flex';
            }
        } else if (e.type === 'VICTORY') {
            player.active = false;
            document.getElementById('active-hud').style.display = 'none';
            document.getElementById('saas-header').style.display = 'flex';
            document.getElementById('dashboard-overlay').style.display = 'flex';

            if (world) {
                world.controls().autoRotate = true;
                world.pointOfView({ lat: 20, lng: 0, altitude: 2.5 }, 1000);
            }

            document.getElementById('victory-tokens').innerText = `+${e.bonusTokens} TOKENS`;
            document.getElementById('victory-screen').style.display = 'flex';
        }
    });
}

async function sendAction(payload) {
    try {
        const res = await fetch('/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playerId, ...payload })
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Action failed');
        }
        return await res.json();
    } catch (e) {
        logMsg(e.message);
        throw e;
    }
}

async function requestSpawn() {
    const query = document.getElementById('start-country').value.trim();
    if (!query) return alert('Select target sector.');

    let finalName = localStorage.getItem('geo_player_name');
    if (!finalName) {
        finalName = prompt('Enter Empire Identifier Name:') || 'Commander';
        localStorage.setItem('geo_player_name', finalName);
    }

    try {
        const result = await sendAction({ type: 'SPAWN', target: query });
        if (result.success) {
            player.active = true;
            player.empireName = profile.username;

            document.getElementById('dashboard-overlay').style.display = 'none';
            document.getElementById('saas-header').style.display = 'none';
            document.getElementById('active-hud').style.display = 'block';

            if (world) world.controls().autoRotate = false;

            const targetNode = mapData.find(f => f.properties.ADMIN === result.country);
            if (targetNode) {
                const centroid = getCentroid(targetNode);
                if (world) world.pointOfView({ lat: centroid[1], lng: centroid[0], altitude: 1.2 }, 2000);
            }

            await pollMapState();
        }
    } catch (e) {
        alert(e.message);
    }
}

async function requestSelfCollapse() {
    if (!confirm('Execute operational abandonment sequence?')) return;
    try {
        await sendAction({ type: 'ABANDON' });
        await pollMapState();
    } catch (e) {}
}

async function upgradeSkill(skill) {
    try {
        const res = await sendAction({ type: 'UPGRADE_SKILL', skill });
        if (res.success) {
            profile = res.profile;
            document.getElementById('player-tokens-val').innerText = profile.tokens;
            updateCommandHubUI();
        }
    } catch (e) {}
}

async function selectColor(color) {
    try {
        const res = await sendAction({ type: 'SELECT_COLOR', color });
        if (res.success) {
            profile = res.profile;
            updateCommandHubUI();
            await pollMapState();
        }
    } catch (e) {}
}

async function handlePolygonClick(d) {
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

    try {
        await sendAction({ type: 'INVADE', target: d.properties.ADMIN });
        logMsg(`Assault launched on ${d.properties.ADMIN}`);
    } catch (e) {}
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
        sendAction({ type: 'NUKE', target: target.properties.ADMIN })
            .then(() => logMsg(`Strategic strike on ${target.properties.ADMIN}`))
            .catch(() => {});
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

function logMsg(msg) {
    const log = document.getElementById('combat-log');
    if (log) log.innerText = msg.toUpperCase();
}

init();
