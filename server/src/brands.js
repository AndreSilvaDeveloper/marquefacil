// Marca por domínio: o mesmo sistema com nome, logo e cores de cada salão.
// O domínio precisa apontar para o servidor e estar no Caddy (deploy/caddy-add-domain.sh).
const DEFAULT = {
  name: 'Marque Fácil',
  short: 'Marque Fácil',
  theme: '#8e3a6b',
  background: '#fbf6f8',
};

const BRANDS = {
  'studiokadosh.com': {
    name: 'Studio Kadosh',
    short: 'Kadosh',
    theme: '#1c1712',
    background: '#fbf8f1',
    logo: '/brands/kadosh/logo.png',
    // cores do app (contraste conferido: botão 5,4:1 com letra branca; topo 8,5:1 com o logo)
    colors: { brand: '#8a6414', brandSoft: '#f6edd6', header: '#1c1712', bg: '#fbf8f1', line: '#eadfc6' },
    // arquivos trocados neste domínio (ícone da tela inicial, das notificações…)
    files: {
      'icon-192.png': 'brands/kadosh/icon-192.png',
      'icon-512.png': 'brands/kadosh/icon-512.png',
      'apple-touch-icon.png': 'brands/kadosh/apple-touch-icon.png',
    },
  },
};

export function brandFor(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
  return BRANDS[host] ? { ...DEFAULT, ...BRANDS[host], host } : { ...DEFAULT, host };
}

// Domínio próprio de um salão (só os cadastrados acima): "studiokadosh.com" ou null
export function brandDomain(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
  return BRANDS[host] ? host : null;
}

// O que o navegador precisa saber (vai em window.BRAND)
export const publicBrand = b => ({ name: b.name, short: b.short, logo: b.logo || null, colors: b.colors || null });

export function manifestFor(b) {
  return {
    name: b.name,
    short_name: b.short,
    description: `Agenda, clientes e financeiro — ${b.name}`,
    lang: 'pt-BR',
    start_url: './#/agenda',
    scope: './',
    display: 'standalone',
    orientation: 'portrait',
    background_color: b.background,
    theme_color: b.theme,
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
}

// Coloca nome, cor e ícones da marca no HTML antes de mandar
export function brandHtml(html, b) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const data = JSON.stringify(publicBrand(b)).replace(/</g, '\\u003c');
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(b.name)}</title>`)
    .replace(/(<meta name="theme-color" content=")[^"]*"/, `$1${esc(b.theme)}"`)
    .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*"/, `$1${esc(b.short)}"`)
    .replace(/<link rel="icon"[^>]*>/, b.files ? '<link rel="icon" href="/icon-192.png" type="image/png">' : '$&')
    .replace(/(<link rel="apple-touch-icon" href=")[^"]*"/, `$1${b.files?.['apple-touch-icon.png'] ? '/apple-touch-icon.png' : '/icon-192.png'}"`)
    .replace(/<script src=/, `<script>window.BRAND = ${data};</script>\n  <script src=`);
}
