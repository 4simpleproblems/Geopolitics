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
        const targetFeature = state.mapData.find(f => f.properties.ADMIN.toLowerCase() === target.toLowerCase());
        if (!targetFeature) {
            return res.status(400).json({ error: 'Nation Unknown.' });
        }

        const isClaimedBySelf = targetFeature.properties.owner === profile.username;
        const isClaimedByOther = targetFeature.properties.owner !== targetFeature.properties.ADMIN && !isClaimedBySelf;
        const isClaimedByActivePlayer = Object.values(state.db).some(p => p.id !== playerId && targetFeature.properties.owner === p.username);

        if (isClaimedByOther || isClaimedByActivePlayer) {
            return res.status(400).json({ error: 'Target sector already claimed.' });
        }

        const econLvl = profile.skills.economicHeadstart || 0;
        const popBoost = 1 + (econLvl * 0.05);

        targetFeature.properties.gameStats.pop = Math.floor(targetFeature.properties.gameStats.pop * popBoost);
        targetFeature.properties.gameStats.mil = Math.floor(targetFeature.properties.gameStats.pop * 0.01);
        targetFeature.properties.owner = profile.username;

        profile.stats.peakMilitary = Math.max(profile.stats.peakMilitary, targetFeature.properties.gameStats.mil);
        state.difficulty = difficulty || 'normal';
        profile.activeGame = true;

        await saveState(state, playerId);
        return res.status(200).json({ success: true, country: targetFeature.properties.ADMIN });
    }

    if (type === 'INVADE') {
        const targetFeature = state.mapData.find(f => f.properties.ADMIN === target);
        if (!targetFeature) {
            return res.status(400).json({ error: 'Target sector not found.' });
        }

        if (targetFeature.properties.owner === profile.username) {
            return res.status(200).json({ success: true });
        }

        const playerLands = state.mapData.filter(f => f.properties.owner === profile.username);
        if (playerLands.length === 0) {
            return res.status(400).json({ error: 'You do not own any sectors.' });
        }

        const isBordering = playerLands.some(land => land.properties.neighbors.includes(target));
        const invadeType = isBordering ? 'border' : 'air';

        let attMil = playerLands.reduce((sum, f) => sum + f.properties.gameStats.mil, 0);
        let defMil = targetFeature.properties.gameStats.mil;

        const baseThreshold = invadeType === 'air' ? 4.0 : 2.5;
        const parityLvl = profile.skills.tacticalParity || 0;
        const thresholdModifier = parityLvl * 0.2;
        const threshold = Math.max(1.2, baseThreshold - thresholdModifier);

        if (defMil > attMil * threshold) {
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
            startCoords: getCentroid(playerLands[0]),
            endCoords: getCentroid(targetFeature),
            color: profile.selectedColor,
            timestamp: Date.now()
        });

        await saveState(state, playerId);
        return res.status(200).json({ success: true, message: 'Assault initiated.' });
    }

    if (type === 'NUKE') {
        const targetFeature = state.mapData.find(f => f.properties.ADMIN === target);
        if (!targetFeature) {
            return res.status(400).json({ error: 'Target sector not found.' });
        }

        const playerLands = state.mapData.filter(f => f.properties.owner === profile.username);
        if (playerLands.length === 0) {
            return res.status(400).json({ error: 'You do not own any sectors.' });
        }

        state.pendingActions.push({
            type: 'NUKE_RESOLVE',
            playerId,
            target,
            resolveTime: Date.now() + 1000
        });

        state.activeEvents.push({
            id: `nuke_${playerId}_${target}_${Date.now()}`,
            type: 'NUKE_LAUNCH',
            attacker: profile.username,
            target,
            startCoords: getCentroid(playerLands[0]),
            endCoords: getCentroid(targetFeature),
            duration: 1000,
            timestamp: Date.now()
        });

        await saveState(state, playerId);
        return res.status(200).json({ success: true, message: 'Strategic strike launched.' });
    }

    if (type === 'UPGRADE_SKILL') {
        const currentLvl = profile.skills[skill] || 0;
        if (currentLvl >= 3) {
            return res.status(400).json({ error: 'Skill already maxed.' });
        }

        let cost = 10;
        if (skill === 'logistics') cost = currentLvl === 0 ? 10 : (currentLvl === 1 ? 25 : 50);
        else if (skill === 'tacticalParity') cost = currentLvl === 0 ? 15 : (currentLvl === 1 ? 30 : 60);
        else if (skill === 'economicHeadstart') cost = currentLvl === 0 ? 12 : (currentLvl === 1 ? 25 : 50);

        if (profile.tokens < cost) {
            return res.status(400).json({ error: 'Insufficient Legacy Tokens.' });
        }

        profile.tokens -= cost;
        profile.skills[skill] = currentLvl + 1;

        await saveState(state, playerId);
        return res.status(200).json({ success: true, profile });
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

        const tokensAwarded = Math.floor((finalTerritories * 4 + finalPeakMil / 15000) * multiplier);
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
