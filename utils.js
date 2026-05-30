/**
 * Geopolitics - Utility Functions
 * Made with ❤️ from 4SP
 */

export const formatNum = (num) => {
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
    return Math.floor(num).toLocaleString();
};

export const getFuzzy = (val, isMoney = false) => {
    const v = val * 0.25;
    const min = Math.max(0, val - v);
    const max = val + v;
    if (isMoney) return `$${formatNum(min)} - $${formatNum(max)}`;
    return `${formatNum(min)} - ${formatNum(max)}`;
};

export const getCentroid = (feature) => {
    try {
        const centroid = turf.centroid(feature);
        return centroid.geometry.coordinates;
    } catch (e) {
        console.error("Centroid calculation failed", e);
        return [0, 0];
    }
};

/**
 * Combines multiple geojson features into one.
 */
export const mergeCountries = (features, newName) => {
    if (features.length < 2) return features[0];
    
    let combined = features[0];
    for (let i = 1; i < features.length; i++) {
        combined = turf.union(combined, features[i]);
    }
    
    // Aggregate stats
    const totalPop = features.reduce((sum, f) => sum + (f.properties.gameStats.pop || 0), 0);
    const totalMil = features.reduce((sum, f) => sum + (f.properties.gameStats.mil || 0), 0);
    const totalEcon = features.reduce((sum, f) => sum + (f.properties.gameStats.econ || 0), 0);
    
    combined.properties = {
        ADMIN: newName,
        ADM0_A3: newName.substring(0, 3).toUpperCase(),
        gameStats: {
            pop: totalPop,
            mil: totalMil,
            econ: totalEcon
        }
    };
    
    return combined;
};

/**
 * Finds the nearest point on any coastline from a given point.
 */
export const snapToCoast = (point, coastlines, threshold = 0.5) => {
    let nearest = null;
    let minDist = Infinity;
    
    // coastlines should be a FeatureCollection of Polygons/LineStrings representing land
    turf.featureEach(coastlines, (feature) => {
        const snapped = turf.nearestPointOnLine(turf.polygonToLine(feature), point);
        const dist = turf.distance(point, snapped);
        if (dist < minDist) {
            minDist = dist;
            nearest = snapped;
        }
    });
    
    if (minDist < threshold) return nearest.geometry.coordinates;
    return point.geometry.coordinates;
};
