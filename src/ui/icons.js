const PATHS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  check: '<path d="M5 12.5 9.5 17 19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4.5h-4.5"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  sparkle: '<path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9 12 3.5Z"/>',
  alert: '<path d="M12 8v5"/><path d="M12 16.5v.5"/><path d="M10.3 4.9 3.1 17.3A1.6 1.6 0 0 0 4.5 19.8h15a1.6 1.6 0 0 0 1.4-2.5L13.7 4.9a1.6 1.6 0 0 0-3.4 0Z"/>',
  key: '<circle cx="8" cy="12" r="3.2"/><path d="M11.2 12H21"/><path d="M17.5 12v3M20 12v2"/>',
  eye: '<path d="M2.8 12S6.5 5.8 12 5.8 21.2 12 21.2 12 17.5 18.2 12 18.2 2.8 12 2.8 12Z"/><circle cx="12" cy="12" r="2.6"/>',
  eyeOff: '<path d="M4 4l16 16"/><path d="M9.5 5.9A9.6 9.6 0 0 1 12 5.8c5.5 0 9.2 6.2 9.2 6.2a17 17 0 0 1-2.5 3.2"/><path d="M6.1 7.5A17 17 0 0 0 2.8 12s3.7 6.2 9.2 6.2c1.2 0 2.3-.3 3.3-.8"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>',
  arrowRight: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m4.5 17 4.8-4.6a1.6 1.6 0 0 1 2.2 0l6 6"/>',
  file: '<path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5Z"/><path d="M13.5 3.5v5h5"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9 7V4.8h6V7"/><path d="M6.5 7l.8 12a1.6 1.6 0 0 0 1.6 1.5h6.2A1.6 1.6 0 0 0 16.7 19l.8-12"/>',
};

export function icon(name, size = 18) {
  const path = PATHS[name] || '';
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}
