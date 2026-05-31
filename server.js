import { WebSocketServer } from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import * as turf from '@turf/turf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const DB_PATH = path.join(__dirname, 'db.json');
const GEO_PATH = path.join(__dirname, 'map.geojson');

let db = {};
let originalFeatures = [];
let mapData = [];
let players = new Map(); 
let activeInvasions = new Map(); 

async function loadDb() {
    try {
        const data = await fs.readFile(DB_PATH, 'utf-8');
        db = JSON.parse(data);
    } catch (e) {
        db = {};
        await saveDb();
    }
}

async function saveDb() {
    try {
        await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
    } catch (e) {
        console.error('Failed to save DB', e);
    }
}

function getCentroid(feature) {
    try {
        const centroid = turf.centroid(feature);
        return centroid.geometry.coordinates;
    } catch (e) {
        return [0, 0];
    }
}

function setupNeighborhoods() {
    mapData.forEach(c1 => {
        c1.properties.neighbors = [];
        const cent1 = getCentroid(c1);
        mapData.forEach(c2 => {
            if (c1 === c2) return;
            const cent2 = getCentroid(c2);
            const dist = Math.sqrt(Math.pow(cent1[0] - cent2[0], 2) + Math.pow(cent1[1] - cent2[1], 2));
            if (dist < 80) {
                c1.properties.neighbors.push(c2.properties.ADMIN);
            }
        });
    });
}

async function initMap() {
    const geoData = JSON.parse(await fs.readFile(GEO_PATH, 'utf-8'));
    originalFeatures = geoData.features.map(f => {
        const p = f.properties;
        const pop = p.POP_EST || 1000000;
        f.properties.owner = p.ADMIN;
        f.properties.gameStats = { pop: pop, mil: Math.floor(pop * 0.01) };
        return f;
    });
    resetMap();
}

function resetMap() {
    mapData = JSON.parse(JSON.stringify(originalFeatures));
    setupNeighborhoods();
    activeInvasions.clear();
}

function getPlayerProfile(id, name) {
    if (!db[id]) {
        db[id] = {
            id,
            username: name || 'Commander ' + Math.floor(1000 + Math.random() * 9000),
            stats: {
                territoriesAnnexed: 0,
                peakMilitary: 0,
                wins: 0,
                survived: 0
            },
            tokens: 0,
            skills: {
                logistics: 0,
                tacticalParity: 0,
                economicHeadstart: 0
            },
            unlockedColors: ['#0070f3'],
            selectedColor: '#0070f3'
        };
    } else if (name) {
        db[id].username = name;
    }
    return db[id];
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
    ws.playerId = null;
    ws.isAlive = true;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            await handleClientMessage(ws, data);
        } catch (e) {
            console.error('Error handling message', e);
        }
    });

    ws.on('close', () => {
        if (ws.playerId) {
            players.delete(ws.playerId);
            broadcastLeaderboard();
        }
    });
});

const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(pingInterval);
});

async function handleClientMessage(ws, data) {
    const { type } = data;

    if (type === 'REGISTER') {
        const { playerId, username } = data;
        const profile = getPlayerProfile(playerId, username);
        ws.playerId = profile.id;
        players.set(profile.id, { ws, profile, spawnedCountry: null, activeStats: { territories: 0, peakMil: 0, noNukes: true } });
        await saveDb();

        ws.send(JSON.stringify({
            type: 'WELCOME',
            profile,
            mapState: getMapStateSummary(),
            leaderboard: getLeaderboard()
        }));

        broadcastLeaderboard();
        return;
    }

    if (!ws.playerId) return;
    const playerSession = players.get(ws.playerId);
    if (!playerSession) return;

    if (type === 'SPAWN') {
        const { country } = data;
        const targetFeature = mapData.find(f => f.properties.ADMIN.toLowerCase() === country.toLowerCase());
        if (!targetFeature) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Nation Unknown.' }));
            return;
        }

        if (targetFeature.properties.owner !== targetFeature.properties.ADMIN) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Target sector already claimed.' }));
            return;
        }

        const activeProfiles = Array.from(players.values()).map(p => p.spawnedCountry);
        if (activeProfiles.includes(targetFeature.properties.ADMIN)) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Target sector already claimed by active player.' }));
            return;
        }

        playerSession.spawnedCountry = targetFeature.properties.ADMIN;
        playerSession.activeStats = { territories: 1, peakMil: 0, noNukes: true };

        const econLvl = playerSession.profile.skills.economicHeadstart || 0;
        const popBoost = 1 + (econLvl * 0.05);
        targetFeature.properties.gameStats.pop = Math.floor(targetFeature.properties.gameStats.pop * popBoost);
        targetFeature.properties.gameStats.mil = Math.floor(targetFeature.properties.gameStats.pop * 0.01);
        targetFeature.properties.owner = playerSession.profile.username;

        playerSession.activeStats.peakMil = targetFeature.properties.gameStats.mil;

        broadcastMapUpdate([targetFeature]);
        broadcastLeaderboard();

        ws.send(JSON.stringify({ type: 'SPAWN_SUCCESS', country: targetFeature.properties.ADMIN }));
        return;
    }

    if (type === 'INVADE') {
        const { target } = data;
        if (!playerSession.spawnedCountry) return;

        const targetFeature = mapData.find(f => f.properties.ADMIN === target);
        if (!targetFeature) return;

        if (targetFeature.properties.owner === playerSession.profile.username) return;

        const playerLands = mapData.filter(f => f.properties.owner === playerSession.profile.username);
        if (playerLands.length === 0) return;

        const isBordering = playerLands.some(land => land.properties.neighbors.includes(target));
        const invadeType = isBordering ? 'border' : 'air';

        let attMil = playerLands.reduce((sum, f) => sum + f.properties.gameStats.mil, 0);
        let defMil = targetFeature.properties.gameStats.mil;

        const baseThreshold = invadeType === 'air' ? 4.0 : 2.5;
        const parityLvl = playerSession.profile.skills.tacticalParity || 0;
        const thresholdModifier = parityLvl * 0.2; 
        const threshold = Math.max(1.2, baseThreshold - thresholdModifier);

        if (defMil > attMil * threshold) {
            ws.send(JSON.stringify({ type: 'LOG', message: `${invadeType.toUpperCase()} ASSAULT IMPOSSIBLE: ${target}` }));
            return;
        }

        const invasionKey = `${playerSession.profile.username}->${target}`;
        if (activeInvasions.has(invasionKey)) return;

        const duration = (invadeType === 'air' ? 4000 : 2000) + (defMil / 50000) * 1000;

        activeInvasions.set(invasionKey, true);

        const sCentroid = getCentroid(playerLands[0]);
        const tCentroid = getCentroid(targetFeature);

        broadcastToAll({
            type: 'INVASION_START',
            attacker: playerSession.profile.username,
            target,
            invadeType,
            duration,
            startCoords: sCentroid,
            endCoords: tCentroid,
            color: playerSession.profile.selectedColor
        });

        setTimeout(() => {
            activeInvasions.delete(invasionKey);
            resolveInvasion(playerSession, targetFeature, invadeType);
        }, duration);

        return;
    }

    if (type === 'NUKE') {
        const { target } = data;
        if (!playerSession.spawnedCountry) return;

        const targetFeature = mapData.find(f => f.properties.ADMIN === target);
        if (!targetFeature) return;

        if (targetFeature.properties.owner === playerSession.profile.username) return;

        const playerLands = mapData.filter(f => f.properties.owner === playerSession.profile.username);
        if (playerLands.length === 0) return;

        const sCentroid = getCentroid(playerLands[0]);
        const tCentroid = getCentroid(targetFeature);

        playerSession.activeStats.noNukes = false;

        broadcastToAll({
            type: 'NUKE_LAUNCH',
            attacker: playerSession.profile.username,
            target,
            startCoords: sCentroid,
            endCoords: tCentroid
        });

        setTimeout(() => {
            targetFeature.properties.gameStats.pop = Math.floor(targetFeature.properties.gameStats.pop * 0.1);
            targetFeature.properties.gameStats.mil = Math.floor(targetFeature.properties.gameStats.mil * 0.05);

            broadcastMapUpdate([targetFeature]);
            broadcastToAll({ type: 'LOG', message: `Impact Confirmed: ${target}` });

            checkPlayerCollapses();
        }, 1000);

        return;
    }

    if (type === 'UPGRADE_SKILL') {
        const { skill } = data;
        const currentLvl = playerSession.profile.skills[skill] || 0;
        if (currentLvl >= 3) return;

        let cost = 10;
        if (skill === 'logistics') cost = currentLvl === 0 ? 10 : (currentLvl === 1 ? 25 : 50);
        else if (skill === 'tacticalParity') cost = currentLvl === 0 ? 15 : (currentLvl === 1 ? 30 : 60);
        else if (skill === 'economicHeadstart') cost = currentLvl === 0 ? 12 : (currentLvl === 1 ? 25 : 50);

        if (playerSession.profile.tokens >= cost) {
            playerSession.profile.tokens -= cost;
            playerSession.profile.skills[skill] = currentLvl + 1;
            await saveDb();

            ws.send(JSON.stringify({ type: 'WELCOME', profile: playerSession.profile, mapState: getMapStateSummary(), leaderboard: getLeaderboard() }));
        }
        return;
    }

    if (type === 'SELECT_COLOR') {
        const { color } = data;
        if (playerSession.profile.unlockedColors.includes(color)) {
            playerSession.profile.selectedColor = color;
            await saveDb();

            ws.send(JSON.stringify({ type: 'WELCOME', profile: playerSession.profile, mapState: getMapStateSummary(), leaderboard: getLeaderboard() }));
        }
        return;
    }

    if (type === 'ABANDON') {
        if (playerSession.spawnedCountry) {
            handlePlayerCollapse(playerSession);
        }
        return;
    }
}

function resolveInvasion(playerSession, targetFeature, type) {
    const attackerName = playerSession.profile.username;
    const targetName = targetFeature.properties.ADMIN;

    const attackerLands = mapData.filter(f => f.properties.owner === attackerName);
    if (attackerLands.length === 0) return;

    if (targetFeature.properties.owner === attackerName) return;

    let attMil = attackerLands.reduce((sum, f) => sum + f.properties.gameStats.mil, 0);
    let defMil = targetFeature.properties.gameStats.mil;

    if (attMil > defMil * 1.05) {
        targetFeature.properties.owner = attackerName;
        targetFeature.properties.gameStats.mil = Math.floor(attMil * 0.05);

        attackerLands.forEach(f => {
            f.properties.gameStats.mil = Math.floor(f.properties.gameStats.mil * 0.9);
        });

        playerSession.activeStats.territories = mapData.filter(f => f.properties.owner === attackerName).length;
        playerSession.profile.stats.territoriesAnnexed++;

        broadcastToAll({ type: 'LOG', message: `Annexation Complete: ${targetName}` });

        checkWinCondition(playerSession);
    } else {
        attackerLands.forEach(f => {
            f.properties.gameStats.mil = Math.floor(f.properties.gameStats.mil * 0.5);
        });
        broadcastToAll({ type: 'LOG', message: `Offensive Repelled: ${targetName}` });
    }

    broadcastMapUpdate([targetFeature, ...attackerLands]);
    broadcastLeaderboard();
    checkPlayerCollapses();
}

function checkPlayerCollapses() {
    players.forEach((session, id) => {
        if (!session.spawnedCountry) return;

        const ownedCount = mapData.filter(f => f.properties.owner === session.profile.username).length;
        if (ownedCount === 0) {
            handlePlayerCollapse(session);
        }
    });
}

function handlePlayerCollapse(session) {
    const finalTerritories = session.activeStats.territories;
    const finalPeakMil = session.activeStats.peakMil;

    const tokensAwarded = Math.floor(finalTerritories * 4 + finalPeakMil / 15000);

    session.profile.tokens += tokensAwarded;
    session.profile.stats.survived++;
    if (finalPeakMil > session.profile.stats.peakMilitary) {
        session.profile.stats.peakMilitary = finalPeakMil;
    }

    if (session.profile.stats.survived >= 5 && !session.profile.unlockedColors.includes('#8b0000')) {
        session.profile.unlockedColors.push('#8b0000'); 
    }
    if (session.profile.stats.territoriesAnnexed >= 50 && !session.profile.unlockedColors.includes('#800080')) {
        session.profile.unlockedColors.push('#800080'); 
    }
    if (session.profile.stats.peakMilitary >= 5000000 && !session.profile.unlockedColors.includes('#39ff14')) {
        session.profile.unlockedColors.push('#39ff14'); 
    }

    saveDb();

    session.ws.send(JSON.stringify({
        type: 'COLLAPSE',
        tokensAwarded,
        stats: {
            territories: finalTerritories,
            peakMil: finalPeakMil
        }
    }));

    session.spawnedCountry = null;
    broadcastLeaderboard();
}

function checkWinCondition(session) {
    const totalSectors = mapData.length;
    const ownedCount = mapData.filter(f => f.properties.owner === session.profile.username).length;
    const pct = ownedCount / totalSectors;

    if (pct >= 0.7) {
        const bonusTokens = 50 + (session.activeStats.noNukes ? 30 : 0);
        session.profile.tokens += bonusTokens;
        session.profile.stats.wins++;

        if (session.activeStats.noNukes && !session.profile.unlockedColors.includes('#ffd700')) {
            session.profile.unlockedColors.push('#ffd700'); 
        }

        saveDb();

        broadcastToAll({
            type: 'VICTORY',
            winner: session.profile.username,
            bonusTokens
        });

        resetMap();
        players.forEach(s => {
            s.spawnedCountry = null;
        });

        broadcastToAll({
            type: 'MAP_INITIAL',
            mapState: getMapStateSummary()
        });

        broadcastLeaderboard();
    }
}

function getMapStateSummary() {
    return mapData.map(f => ({
        admin: f.properties.ADMIN,
        owner: f.properties.owner,
        pop: f.properties.gameStats.pop,
        mil: f.properties.gameStats.mil,
        color: getOwnerColorFromServer(f.properties.owner)
    }));
}

function getOwnerColorFromServer(ownerName) {
    for (let session of players.values()) {
        if (session.profile.username === ownerName) {
            return session.profile.selectedColor;
        }
    }
    return null; 
}

function getLeaderboard() {
    let scores = {};
    mapData.forEach(f => {
        const owner = f.properties.owner;
        if (!scores[owner]) scores[owner] = { terr: 0, mil: 0, isPlayer: false, color: '#fff' };
        scores[owner].terr++;
        scores[owner].mil += f.properties.gameStats.mil;
    });

    players.forEach(s => {
        if (scores[s.profile.username]) {
            scores[s.profile.username].isPlayer = true;
            scores[s.profile.username].color = s.profile.selectedColor;
        }
    });

    const sorted = Object.entries(scores)
        .map(([name, data]) => ({ name, ...data }))
        .sort((a, b) => b.terr - a.terr)
        .slice(0, 20);

    const playersByTokens = Object.values(db)
        .sort((a, b) => (b.tokens + (b.stats.wins * 100)) - (a.tokens + (a.stats.wins * 100)))
        .slice(0, 20)
        .map(p => ({ username: p.username, tokens: p.tokens, wins: p.stats.wins }));

    return {
        mapControl: sorted,
        globalLeaderboard: playersByTokens
    };
}

function broadcastLeaderboard() {
    broadcastToAll({
        type: 'LEADERBOARD_UPDATE',
        leaderboard: getLeaderboard()
    });
}

function broadcastMapUpdate(features) {
    broadcastToAll({
        type: 'MAP_UPDATE',
        updates: features.map(f => ({
            admin: f.properties.ADMIN,
            owner: f.properties.owner,
            pop: f.properties.gameStats.pop,
            mil: f.properties.gameStats.mil,
            color: getOwnerColorFromServer(f.properties.owner)
        }))
    });
}

function broadcastToAll(messageObj) {
    const messageStr = JSON.stringify(messageObj);
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(messageStr);
        }
    });
}

function gameTick() {
    mapData.forEach(f => {
        let growthRate = 0.003; 
        const owner = f.properties.owner;
        let ownerSession = null;
        for (let s of players.values()) {
            if (s.profile.username === owner) {
                ownerSession = s;
                break;
            }
        }

        if (ownerSession) {
            const logisticsLvl = ownerSession.profile.skills.logistics || 0;
            growthRate += logisticsLvl * 0.001; 
        }

        f.properties.gameStats.mil += Math.floor(f.properties.gameStats.pop * growthRate);

        if (ownerSession) {
            const currentTotalMil = mapData.filter(x => x.properties.owner === owner)
                .reduce((sum, x) => sum + x.properties.gameStats.mil, 0);
            if (currentTotalMil > ownerSession.activeStats.peakMil) {
                ownerSession.activeStats.peakMil = currentTotalMil;
            }
        }
    });

    const empiresList = [...new Set(mapData.map(f => f.properties.owner))];

    empiresList.forEach(emp => {
        let isHuman = false;
        for (let s of players.values()) {
            if (s.profile.username === emp) {
                isHuman = true;
                break;
            }
        }
        if (isHuman) return; 

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

        let target = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];

        const playerEmpireNames = Array.from(players.values()).map(s => s.profile.username);
        const playerTargets = potentialTargets.filter(t => playerEmpireNames.includes(t.properties.owner));
        if (playerTargets.length > 0) {
            target = playerTargets[Math.floor(Math.random() * playerTargets.length)];
        }

        const totalMil = myLands.reduce((sum, f) => sum + f.properties.gameStats.mil, 0);
        if (totalMil > target.properties.gameStats.mil * 1.5 && target.properties.gameStats.mil < totalMil * 0.6) {
            const duration = 2000 + (target.properties.gameStats.mil / 50000) * 1000;
            const invasionKey = `${emp}->${target.properties.ADMIN}`;

            if (activeInvasions.has(invasionKey)) return;
            activeInvasions.set(invasionKey, true);

            const sCentroid = getCentroid(myLands[0]);
            const tCentroid = getCentroid(target);

            broadcastToAll({
                type: 'INVASION_START',
                attacker: emp,
                target: target.properties.ADMIN,
                invadeType: 'border',
                duration,
                startCoords: sCentroid,
                endCoords: tCentroid,
                color: null
            });

            setTimeout(() => {
                activeInvasions.delete(invasionKey);
                if (target.properties.owner === emp) return;

                let currentAttMil = myLands.reduce((sum, f) => sum + f.properties.gameStats.mil, 0);
                let currentDefMil = target.properties.gameStats.mil;

                if (currentAttMil > currentDefMil * 1.05) {
                    target.properties.owner = emp;
                    target.properties.gameStats.mil = Math.floor(currentAttMil * 0.05);
                    myLands.forEach(f => f.properties.gameStats.mil = Math.floor(f.properties.gameStats.mil * 0.9));
                } else {
                    myLands.forEach(f => f.properties.gameStats.mil = Math.floor(f.properties.gameStats.mil * 0.5));
                }

                broadcastMapUpdate([target, ...myLands]);
                broadcastLeaderboard();
                checkPlayerCollapses();
            }, duration);
        }
    });

    broadcastMapUpdate(mapData);
}

let tickInterval = null;

async function startServer() {
    await loadDb();
    await initMap();
    console.log(`Server authoritative state loaded. Listening on port ${PORT}`);
    tickInterval = setInterval(gameTick, 2000);
}

startServer().catch(console.error);
