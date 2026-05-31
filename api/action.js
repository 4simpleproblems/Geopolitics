import { getState, saveState, loadOriginalMap } from './_state.js';

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

function getClosestPlayerLand(playerLands, targetFeature) {
    if (playerLands.length === 0) return null;
    let closestLand = playerLands[0];
    let minDist = Infinity;
    const tCentroid = getCentroid(targetFeature);
    for (const land of playerLands) {
        const sCentroid = getCentroid(land);
        const dist = Math.pow(sCentroid[0] - tCentroid[0], 2) + Math.pow(sCentroid[1] - tCentroid[1], 2);
        if (dist < minDist) {
            minDist = dist;
            closestLand = land;
        }
    }
    return closestLand;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { playerId, type, target, skill, color, difficulty, saveId, newTitle, saveData } = req.body;
    if (!playerId) {
        return res.status(400).json({ error: 'Player ID required' });
    }

    const state = await getState(playerId);
    const profile = state.db[playerId];

    if (!profile) {
        return res.status(404).json({ error: 'Profile not found' });
    }

    if (!state.pendingActions) state.pendingActions = [];

    if (type === 'SPAWN') {
        state.mapData = await loadOriginalMap();
        state.pendingActions = [];
        state.activeEvents = [];
        state.isPaused = false;
        state.lastTick = Date.now();

        const targetFeature = state.mapData.find(f => f.properties.ADMIN.toLowerCase() === target.toLowerCase());
        if (!targetFeature) {
            return res.status(400).json({ error: 'Nation Unknown.' });
        }

        profile.username = targetFeature.properties.ADMIN;

        const econLvl = profile.skills.economicHeadstart || 0;
        const popBoost = 1 + (econLvl * 0.05);

        targetFeature.properties.gameStats.pop = Math.floor(targetFeature.properties.gameStats.pop * popBoost);
        targetFeature.properties.gameStats.mil = Math.floor(targetFeature.properties.gameStats.pop * 0.01);
        targetFeature.properties.owner = profile.username;

        profile.stats.peakMilitary = Math.max(profile.stats.peakMilitary, targetFeature.properties.gameStats.mil);
        state.difficulty = difficulty || 'normal';
        profile.activeGame = true;

        await saveState(state, playerId);
        return res.status(200).json({ success: true, country: targetFeature.properties.ADMIN, profile });
    }

    if (type === 'UNLOCK_SKILL') {
        const { skillId } = req.body;
        const costs = {
            invasion: 0,
            airstrike: 10,
            nuke: 25,
            propaganda: 15,
            intelHack: 8,
            logistics: 12
        };
        const cost = costs[skillId] || 0;
        if (profile.tokens < cost) {
            return res.status(400).json({ error: 'Insufficient Legacy Tokens.' });
        }
        if (profile.skills[skillId]) {
            return res.status(400).json({ error: 'Skill already unlocked.' });
        }
        profile.tokens -= cost;
        profile.skills[skillId] = true;
        await saveState(state, playerId);
        return res.status(200).json({ success: true, profile });
    }

    if (type === 'SET_LOADOUT') {
        const { loadout } = req.body;
        if (!Array.isArray(loadout) || loadout.length > 4) {
            return res.status(400).json({ error: 'Invalid loadout.' });
        }
        const allUnlocked = loadout.every(skillId => profile.skills[skillId]);
        if (!allUnlocked) {
            return res.status(400).json({ error: 'Cannot equip locked skills.' });
        }
        profile.skills.loadout = loadout;
        await saveState(state, playerId);
        return res.status(200).json({ success: true, profile });
    }

    if (type === 'USE_SKILL') {
        const { skillId } = req.body;
        const targetFeature = state.mapData.find(f => f.properties.ADMIN === target);
        if (!targetFeature) {
            return res.status(400).json({ error: 'Target country not found.' });
        }

        const playerLands = state.mapData.filter(f => f.properties.owner === profile.username);
        if (playerLands.length === 0) {
            return res.status(400).json({ error: 'You do not own any countries.' });
        }

        const sourceLand = getClosestPlayerLand(playerLands, targetFeature);
        if (!sourceLand) {
            return res.status(400).json({ error: 'Source territory not found.' });
        }

        const currentLoadout = profile.skills.loadout || ['invasion'];
        if (!currentLoadout.includes(skillId)) {
            return res.status(400).json({ error: 'Skill not equipped in loadout.' });
        }

        const totalMil = playerLands.reduce((sum, f) => sum + f.properties.gameStats.mil, 0);
        
        const costs = {
            invasion: 0,
            airstrike: 150000,
            nuke: 600000,
            propaganda: 100000,
            intelHack: 50000,
            logistics: 80000
        };

        const cost = costs[skillId] || 0;
        if (totalMil < cost) {
            return res.status(400).json({ error: `Insufficient military force. Need ${cost.toLocaleString()} troops.` });
        }

        if (cost > 0) {
            playerLands.forEach(f => {
                f.properties.gameStats.mil = Math.floor(f.properties.gameStats.mil * (1 - cost / totalMil));
            });
        }

        if (skillId === 'invasion') {
            const isBordering = playerLands.some(land => land.properties.neighbors.includes(target));
            const invadeType = isBordering ? 'border' : 'air';

            let attMil = playerLands.reduce((sum, f) => sum + f.properties.gameStats.mil, 0);
            let defMil = targetFeature.properties.gameStats.mil;

            const hacked = targetFeature.properties.gameStats.intelHackedUntil && targetFeature.properties.gameStats.intelHackedUntil > Date.now();
            const requiredRatio = hacked ? 0.8 : 1.1;

            if (attMil < defMil * requiredRatio) {
                return res.status(400).json({ error: 'Assault impossible. Defense strength too high.' });
            }

            const duration = (invadeType === 'air' ? 4000 : 2000) + (defMil / 50000) * 1000;
            const resolveTime = Date.now() + duration;

            state.pendingActions.push({
                type: 'INVADE_RESOLVE',
                playerId,
                target,
                invadeType,
                resolveTime
            });

            state.activeEvents.push({
                id: `inv_${playerId}_${target}_${Date.now()}`,
                type: 'INVASION_START',
                attacker: profile.username,
                target,
                invadeType,
                duration,
                startCoords: getCentroid(sourceLand),
                endCoords: getCentroid(targetFeature),
                color: profile.selectedColor,
                timestamp: Date.now()
            });

            await saveState(state, playerId);
            return res.status(200).json({ success: true, message: 'Assault initiated.', profile });
        }

        if (skillId === 'airstrike') {
            targetFeature.properties.gameStats.mil = Math.floor(targetFeature.properties.gameStats.mil * 0.65);
            
            state.activeEvents.push({
                id: `air_${playerId}_${target}_${Date.now()}`,
                type: 'INVASION_START',
                attacker: profile.username,
                target,
                invadeType: 'border',
                duration: 1000,
                startCoords: getCentroid(sourceLand),
                endCoords: getCentroid(targetFeature),
                color: '#ffaa00',
                timestamp: Date.now()
            });

            await saveState(state, playerId);
            return res.status(200).json({ success: true, message: 'Airstrike successful. Enemy forces weakened.', profile });
        }

        if (skillId === 'nuke') {
            targetFeature.properties.gameStats.mil = Math.floor(targetFeature.properties.gameStats.mil * 0.1);
            targetFeature.properties.gameStats.pop = Math.floor(targetFeature.properties.gameStats.pop * 0.2);
            targetFeature.properties.gameStats.fallout = true;

            let surrendered = false;
            if (targetFeature.properties.gameStats.mil < totalMil * 0.15 || targetFeature.properties.gameStats.mil < 50000) {
                targetFeature.properties.owner = profile.username;
                targetFeature.properties.gameStats.mil = Math.floor(totalMil * 0.02) + 1000;
                surrendered = true;
                profile.stats.territoriesAnnexed++;

                const totalSectors = state.mapData.length;
                const ownedCount = state.mapData.filter(f => f.properties.owner === profile.username).length;
                const pct = ownedCount / totalSectors;
                if (pct >= 0.7) {
                    profile.activeGame = false;
                    let multiplier = 1.0;
                    if (state.difficulty === 'easy') multiplier = 0.5;
                    if (state.difficulty === 'hard') multiplier = 2.0;
                    const bonusTokens = Math.floor(50 * multiplier);
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

            state.activeEvents.push({
                id: `nuke_${playerId}_${target}_${Date.now()}`,
                type: 'NUKE_LAUNCH',
                attacker: profile.username,
                target,
                startCoords: getCentroid(sourceLand),
                endCoords: getCentroid(targetFeature),
                duration: 1000,
                timestamp: Date.now()
            });

            await saveState(state, playerId);
            if (surrendered) {
                return res.status(200).json({ success: true, message: `Surrender Confirmed: ${target} surrendered to your forces.`, profile });
            }
            return res.status(200).json({ success: true, message: 'Strategic nuke detonated. Radiation fallout detected.', profile });
        }

        if (skillId === 'propaganda') {
            const convertAmount = Math.floor(targetFeature.properties.gameStats.mil * 0.25);
            targetFeature.properties.gameStats.mil -= convertAmount;
            sourceLand.properties.gameStats.mil += convertAmount;

            state.activeEvents.push({
                id: `prop_${playerId}_${target}_${Date.now()}`,
                type: 'INVASION_START',
                attacker: profile.username,
                target,
                invadeType: 'border',
                duration: 1000,
                startCoords: getCentroid(sourceLand),
                endCoords: getCentroid(targetFeature),
                color: '#ffffff',
                timestamp: Date.now()
            });

            await saveState(state, playerId);
            return res.status(200).json({ success: true, message: 'Propaganda successful. Converted enemy forces.', profile });
        }

        if (skillId === 'intelHack') {
            targetFeature.properties.gameStats.intelHackedUntil = Date.now() + 45000;

            await saveState(state, playerId);
            return res.status(200).json({ success: true, message: 'Systems hacked. Defense threshold temporarily reduced.', profile });
        }

        if (skillId === 'logistics') {
            profile.logisticsBoostUntil = Date.now() + 30000;

            await saveState(state, playerId);
            return res.status(200).json({ success: true, message: 'Logistics boost activated. Production tripled.', profile });
        }

        return res.status(400).json({ error: 'Invalid skill action' });
    }

    if (type === 'SELECT_COLOR') {
        if (!profile.unlockedColors.includes(color)) {
            return res.status(400).json({ error: 'Color not unlocked.' });
        }

        profile.selectedColor = color;
        await saveState(state, playerId);
        return res.status(200).json({ success: true, profile });
    }

    if (type === 'ABANDON') {
        const playerLands = state.mapData.filter(f => f.properties.owner === profile.username);
        const finalTerritories = playerLands.length;
        const finalPeakMil = playerLands.reduce((sum, f) => sum + f.properties.gameStats.mil, 0);

        let multiplier = 1.0;
        if (state.difficulty === 'easy') multiplier = 0.5;
        if (state.difficulty === 'hard') multiplier = 2.0;

        const falloutCount = playerLands.filter(f => f.properties.gameStats.fallout).length;
        const effectiveTerritories = (finalTerritories - falloutCount) + (falloutCount * 0.2);

        const tokensAwarded = Math.floor((effectiveTerritories * 4 + finalPeakMil / 15000) * multiplier);
        profile.tokens += tokensAwarded;
        profile.stats.survived++;
        profile.activeGame = false;

        if (finalPeakMil > profile.stats.peakMilitary) {
            profile.stats.peakMilitary = finalPeakMil;
        }

        if (profile.stats.survived >= 5 && !profile.unlockedColors.includes('#8b0000')) {
            profile.unlockedColors.push('#8b0000');
        }
        if (profile.stats.territoriesAnnexed >= 50 && !profile.unlockedColors.includes('#800080')) {
            profile.unlockedColors.push('#800080');
        }
        if (profile.stats.peakMilitary >= 5000000 && !profile.unlockedColors.includes('#39ff14')) {
            profile.unlockedColors.push('#39ff14');
        }

        playerLands.forEach(f => {
            f.properties.owner = f.properties.ADMIN;
            f.properties.gameStats.mil = Math.floor(f.properties.gameStats.pop * 0.01);
        });

        state.activeEvents.push({
            id: `collapse_${playerId}_${Date.now()}`,
            type: 'COLLAPSE',
            playerId,
            tokensAwarded,
            stats: { territories: finalTerritories, peakMil: finalPeakMil },
            timestamp: Date.now(),
            duration: 5000
        });

        await saveState(state, playerId);
        return res.status(200).json({ success: true, collapsed: true });
    }

    if (type === 'SAVE_GAME') {
        const title = req.body.title || 'Untitled Save';
        const isCloud = req.body.isCloud;
        const newSave = {
            id: 'save_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
            title,
            timestamp: Date.now(),
            mapData: state.mapData,
            pendingActions: state.pendingActions || [],
            activeEvents: state.activeEvents || [],
            difficulty: state.difficulty || 'normal'
        };
        if (isCloud) {
            if (!profile.saves) profile.saves = [];
            if (profile.saves.length >= 5) {
                return res.status(400).json({ error: 'Maximum 5 cloud saves reached.' });
            }
            profile.saves.push(newSave);
            await saveState(state, playerId);
            return res.status(200).json({ success: true, profile });
        } else {
            return res.status(200).json({ success: true, saveData: newSave });
        }
    }

    if (type === 'LOAD_GAME') {
        let loadedData = null;
        if (req.body.isCloud) {
            if (!profile.saves) profile.saves = [];
            loadedData = profile.saves.find(s => s.id === saveId);
            if (!loadedData) return res.status(404).json({ error: 'Cloud save not found.' });
        } else {
            loadedData = saveData;
            if (!loadedData) return res.status(400).json({ error: 'Save data required.' });
        }
        state.mapData = loadedData.mapData;
        state.lastTick = Date.now();
        state.pendingActions = loadedData.pendingActions || [];
        state.activeEvents = loadedData.activeEvents || [];
        state.difficulty = loadedData.difficulty || 'normal';
        state.isPaused = false;
        profile.activeGame = true;
        await saveState(state, playerId);
        return res.status(200).json({ success: true, profile });
    }

    if (type === 'DELETE_CLOUD_SAVE') {
        if (!profile.saves) profile.saves = [];
        profile.saves = profile.saves.filter(s => s.id !== saveId);
        await saveState(state, playerId);
        return res.status(200).json({ success: true, profile });
    }

    if (type === 'RENAME_CLOUD_SAVE') {
        if (!profile.saves) profile.saves = [];
        const save = profile.saves.find(s => s.id === saveId);
        if (save) {
            save.title = newTitle || 'Untitled Save';
            await saveState(state, playerId);
        }
        return res.status(200).json({ success: true, profile });
    }

    if (type === 'TOGGLE_PAUSE') {
        state.isPaused = !state.isPaused;
        await saveState(state, playerId);
        return res.status(200).json({ success: true, isPaused: state.isPaused });
    }

    return res.status(400).json({ error: 'Invalid action type' });
}
