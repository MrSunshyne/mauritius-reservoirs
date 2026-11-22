// Numbers the 3D model and the text share. Kept free of three.js so the page can use
// them before the 3D code loads.

export const TERRAIN_EXAG = 2.2; // heights drawn this many times taller
export const BASIN_EXAG = 3; // modelled basin depths drawn this many times deeper again
export const BASIN_SHAPE = 1.1; // depth = D * (distance from shore / max distance) ^ BASIN_SHAPE
export const CRITICAL = 25; // % below which a reservoir is marked critically low
