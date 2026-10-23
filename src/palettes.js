// Luminous colorways for the orb. Four gradient stops, top of the orb to the bottom,
// plus the accent the interface uses for text and controls.
export const PALETTES = {
  aurora: { label: 'Aurora', stops: ['#3d7bff', '#4fd2ff', '#8f6bff', '#ff8ad8'], ui: '#6fd0ff' },
  lakay: { label: 'Lakay', stops: ['#2f5bff', '#4f8cff', '#ff4d6d', '#e8173f'], ui: '#7aa2ff' },
  siri: { label: 'Siri', stops: ['#ff3fa4', '#8a4dff', '#2fc6ff', '#43ffd0'], ui: '#c58bff' },
  ember: { label: 'Ember', stops: ['#ffd36b', '#ff8a3d', '#ff3d72', '#a63dff'], ui: '#ffb05a' },
  borealis: { label: 'Borealis', stops: ['#8dffd5', '#2fe6a6', '#1f9fff', '#6a5cff'], ui: '#5ff0c0' },
  ice: { label: 'Ice', stops: ['#ffffff', '#bfe6ff', '#8fb3ff', '#d2c2ff'], ui: '#cfeaff' },
};
export const DEFAULT_PALETTE = 'aurora';

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
