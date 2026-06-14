import {staticFile} from 'remotion';

// Bundled, self-hosted fonts (copied from the site's public/fonts).
// No external/CDN fetch at runtime.
export const loadFonts = () => {
  if (typeof document === 'undefined') return;
  if (document.getElementById('kolm-fonts')) return;
  const style = document.createElement('style');
  style.id = 'kolm-fonts';
  style.textContent = `
    @font-face{font-family:'Geist';src:url(${staticFile('fonts/Geist.woff2')}) format('woff2');font-weight:100 900;font-display:block;}
    @font-face{font-family:'Geist Mono';src:url(${staticFile('fonts/GeistMono.woff2')}) format('woff2');font-weight:100 900;font-display:block;}
  `;
  document.head.appendChild(style);
};

export const SANS = "'Geist', system-ui, 'Segoe UI', Arial, sans-serif";
export const MONO = "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace";
