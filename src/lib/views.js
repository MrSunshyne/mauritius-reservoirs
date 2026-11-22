// The ways the 3D view can draw the fill levels. Kept free of three.js so the
// page can show the switcher before the 3D code loads.
export const VIEW_OPTIONS = [
  { id: "basins", label: "Basins" },
  { id: "gauges", label: "Gauges" },
  { id: "prisms", label: "Prisms" },
];
export const DEFAULT_VIEW = "basins";

// Modelled basin depths are drawn this many times deeper, on top of the terrain's 2.2×.
export const BASIN_EXAG = 3;
