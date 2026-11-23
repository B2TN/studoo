// Mini-routeur : associe une adresse (/cours/123) à une fonction qui dessine la page,
// sans recharger le site (History API).

export function compile(pattern) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return "/([^/]+)"; }) + "/?$");
  return { re, keys };
}

export function match(routes, path) {
  for (const route of routes) {
    route.compiled ||= compile(route.path);
    const m = route.compiled.re.exec(path);
    if (m) {
      const params = {};
      route.compiled.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route, params };
    }
  }
  return null;
}

export function createRouter(routes, render) {
  const state = { current: null };
  async function go(path, { replace = false, data } = {}) {
    if (replace) history.replaceState(data ?? null, "", path);
    else history.pushState(data ?? null, "", path);
    await run();
  }
  async function run() {
    const url = new URL(location.href);
    const found = match(routes, url.pathname);
    state.current = found;
    await render(found, { query: url.searchParams, data: history.state });
  }
  window.addEventListener("popstate", run);
  // Intercepte les clics sur les liens internes (<a href="/...">)
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a || a.target || a.hasAttribute("download") || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || !a.dataset.link) return;
    e.preventDefault();
    go(url.pathname + url.search);
  });
  return { go, run, state };
}
