// Chargé avant tout le reste : évite de voir la page d'accueil « clignoter »
// quand on est déjà connecté, et applique le thème choisi.
(function () {
  var root = document.documentElement;
  if (document.cookie.split("; ").indexOf("studoo_in=1") !== -1) root.classList.add("is-app");
  try {
    var t = JSON.parse(localStorage.getItem("studoo-theme"));
    if (t) root.dataset.theme = t;
    if (JSON.parse(localStorage.getItem("studoo-font")) === "lisible") root.dataset.font = "lisible";
  } catch (e) { /* stockage indisponible */ }
})();
