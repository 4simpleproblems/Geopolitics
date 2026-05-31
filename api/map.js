import { getState, saveState } from './_state.js';

function getCentroid(feature) {
    if (feature.geometry && feature.geometry.coordinates) {
        if (feature.geometry.type === 'Polygon') {
            const coords = feature.geometry.coordinates[0];
            let x = 0, y = 0;
            coords.forEach(pt => { x += pt[0]; y += pt[1]; });
            return [x / coords.length, y / coords.length];
        } else if (feature.geometry.type === 'MultiPolygon') {
            const coords = feature.geometry.coordinates[0][0];
            let x = 0, y = 0;
            coords.forEach(pt => { x += pt[0]; y += pt[1]; });
            return [x / coords.length, y / coords.length];
        }
    }
    return [0, 0];
}

export default async function handler(req, res) {
    const { playerId } = req.query;
    const state = await getState();

    const now = Date.now();

    if (state.pendingActions && state.pendingActions.length > 0) {
        const actionsToResolve = state.pendingActions.filter(a => a.resolveTime <= now);
        state.pendingActions = state.pendingActions.filter(a => a.resolveTime > now);

        actionsToResolve.forEach(action => {
            resolvePendingAction(state, action);
        });
    }

    const elapsed = now - state.lastTick;
    const ticks = Math.floor(elapsed / 2000);

    if (ticks > 0) {
        const playersList = Object.values(state.db);

        for (let t = 0; t < ticks; t++) {
            state.mapData.forEach(f => {
                let growthRate = 0.003;
                const owner = f.properties.owner;
                const ownerProfile = playersList.find(p => p.username === owner);

                if (ownerProfile) {
                    const logisticsLvl = ownerProfile.skills.logistics || 0;
                    growthRate += logisticsLvl * 0.001;
                }

                f.properties.gameStats.mil += Math.floor(f.properties.gameStats.pop * growthRate);

                if (ownerProfile) {
                    const totalMil = state.mapData.filter(x => x.properties.owner === owner)
                        .reduce((sum, x) => sum + x.properties.gameStats.mil, 0);
                    if (totalMil > ownerProfile.stats.peakMilitary) {
                        ownerProfile.stats.peakMilitary = totalMil;
                    }
                }
            });

            const uniqueOwners = [...new Set(state.mapData.map(f => f.properties.owner))];

            uniqueOwners.forEach(emp => {
                const isHuman = playersList.some(p => p.username === emp);
                if (isHuman) return;

                const myLands = state.mapData.filter(f => f.properties.owner === emp);
                if (myLands.length === 0) return;

                let potentialTargets = [];
                myLands.forEach(land => {
                    land.properties.neighbors.forEach(nName => {
                        const nNode = state.mapData.find(f => f.properties.ADMIN === nName);
                        if (nNode && nNode.properties.owner !== emp) {
                            potentialTargets.push(nNode);
                        }
                    });
                });

                if (potentialTargets.length === 0) return;

                let target = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];

                const playerNames = playersList.map(p => p.username);
                const playerTargets = potentialTargets.filter(t => playerNames.includes(t.properties.owner));
                if (playerTargets.length > 0) {
                    target = playerTargets[Math.floor(Math.random() * playerTargets.length)];
                }

                const totalMil = myLands.reduce((sum, f) => sum + f.properties.gameStats.mil, 0);
                const targetMil = target.properties.gameStats.mil;

                if (totalMil > targetMil * 1.5 && targetMil < totalMil * 0.6) {
                    const duration = 2000 + (targetMil / 50000) * 1000;
                    const eventId = `ai_inv_${emp}_${target.properties.ADMIN}_${Date.now()}`;

                    if (state.activeEvents.some(e => e.id === eventId)) return;

                    target.properties.owner = emp;
                    target.properties.gameStats.mil = Math.floor(totalMil * 0.05);
                    myLands.forEach(f => f.properties.gameStats.mil = Math.floor(f.properties.gameStats.mil * 0.9));

                    state.activeEvents.push({
                        id: eventId,
                        type: 'INVASION_START',
                        attacker: emp,
                        target: target.properties.ADMIN,
                        invadeType: 'border',
                        duration,
                        startCoords: getCentroid(myLands[0]),
                        endCoords: getCentroid(target),
                        color: null,
                        timestamp: Date.now()
                    });
                }
            });

            checkPlayerCollapses(state);
        }

        state.activeEvents = state.activeEvents.filter(e => e.timestamp + e.duration > now);
        state.lastTick = state.lastTick + (ticks * 2000);
        await saveState(state);
    }

    const leaderboard = getLeaderboard(state);
    const welcomeProfile = playerId ? state.db[playerId] : null;

    return res.status(200).json({
        mapState: getMapStateSummary(state),
        leaderboard,
        activeEvents: state.activeEvents,
        welcomeProfile
    });
}

function checkPlayerCollapses(state) {
    const playersList = Object.values(state.db);
    playersList.forEach(profile => {
        const ownedCount = state.mapData.filter(f => f.properties.owner === profile.username).length;
        if (ownedCount === 0 && profile.stats.survived < profile.stats.wins + 1) {
            handlePlayerCollapse(state, profile);
        }
    });
}

function handlePlayerCollapse(state, profile) {
    const tokensAwarded = 5; 
    profile.tokens += tokensAwarded;
    profile.stats.survived++;

    if (profile.stats.survived >= 5 && !profile.unlockedColors.includes('#8b0000')) {
        profile.unlockedColors.push('#8b0000');
    }
    if (profile.stats.territoriesAnnexed >= 50 && !profile.unlockedColors.includes('#800080')) {
        profile.unlockedColors.push('#800080');
    }
    if (profile.stats.peakMilitary >= 5000000 && !profile.unlockedColors.includes('#39ff14')) {
        profile.unlockedColors.push('#39ff14');
    }

    state.activeEvents.push({
        id: `collapse_${profile.id}_${Date.now()}`,
        type: 'COLLAPSE',
        playerId: profile.id,
        tokensAwarded,
        stats: { territories: 0, peakMil: profile.stats.peakMilitary },
        timestamp: Date.now(),
        duration: 5000
    });
}

function getMapStateSummary(state) {
    return state.mapData.map(f => ({
        admin: f.properties.ADMIN,
        owner: f.properties.owner,
        pop: f.properties.gameStats.pop,
        mil: f.properties.gameStats.mil,
        color: getOwnerColor(state, f.properties.owner)
    }));
}

function getOwnerColor(state, ownerName) {
    const playersList = Object.values(state.db);
    const owner = playersList.find(p => p.username === ownerName);
    return owner ? owner.selectedColor : null;
}

function getLeaderboard(state) {
    let scores = {};
    state.mapData.forEach(f => {
        const owner = f.properties.owner;
        if (!scores[owner]) scores[owner] = { terr: 0, mil: 0, isPlayer: false, color: '#fff' };
        scores[owner].terr++;
        scores[owner].mil += f.properties.gameStats.mil;
    });

    const playersList = Object.values(state.db);
    playersList.forEach(p => {
        if (scores[p.username]) {
            scores[p.username].isPlayer = true;
            scores[p.username].color = p.selectedColor;
        }
    });

    const sorted = Object.entries(scores)
        .map(([name, data]) => ({ name, ...data }))
        .sort((a, b) => b.terr - a.terr)
        .slice(0, 20);

    const playersByTokens = playersList
        .sort((a, b) => (b.tokens + (b.stats.wins * 100)) - (a.tokens + (a.stats.wins * 100)))
        .slice(0, 20)
        .map(p => ({ username: p.username, tokens: p.tokens, wins: p.stats.wins }));

    return {
        mapControl: sorted,
        globalLeaderboard: playersByTokens
    };
}

function resolvePendingAction(state, action) {
    const { type, playerId, target, invadeType } = action;
    const profile = state.db[playerId];
    if (!profile) return;

    const targetFeature = state.mapData.find(f => f.properties.ADMIN === target);
    if (!targetFeature) return;

    if (type === 'INVADE_RESOLVE') {
        const attackerName = profile.username;
        const targetName = targetFeature.properties.ADMIN;

        const attackerLands = state.mapData.filter(f => f.properties.owner === attackerName);
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

            profile.stats.territoriesAnnexed++;
            checkWinCondition(state, profile);
        } else {
            attackerLands.forEach(f => {
                f.properties.gameStats.mil = Math.floor(f.properties.gameStats.mil * 0.5);
            });
        }
    } else if (type === 'NUKE_RESOLVE') {
        targetFeature.properties.gameStats.pop = Math.floor(targetFeature.properties.gameStats.pop * 0.1);
        targetFeature.properties.gameStats.mil = Math.floor(targetFeature.properties.gameStats.mil * 0.05);
    }
}

function checkWinCondition(state, profile) {
    const totalSectors = state.mapData.length;
    const ownedCount = state.mapData.filter(f => f.properties.owner === profile.username).length;
    const pct = ownedCount / totalSectors;

    if (pct >= 0.7) {
        const bonusTokens = 50;
        profile.tokens += bonusTokens;
        profile.stats.wins++;

        state.activeEvents.push({
            id: `victory_${profile.id}_${Date.now()}`,
            type: 'VICTORY',
            winner: profile.username,
            bonusTokens,
            timestamp: Date.now(),
            duration: 8000
        });

        state.mapData = state.mapData.map(f => {
            f.properties.owner = f.properties.ADMIN;
            const pop = f.properties.POP_EST || 1000000;
            f.properties.gameStats = { pop, mil: Math.floor(pop * 0.01) };
            return f;
        });
        state.pendingActions = [];
    }
}

