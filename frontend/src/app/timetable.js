import { h, mount } from "../lib/dom.js";

export async function render({ view, route }) {
  mount(view, h("h1", { class: "view-title" }, route.title), h("p", {}, "Bientôt."));
}
