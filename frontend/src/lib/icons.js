// Icônes Tabler (licence MIT) importées une par une : seules celles-ci
// sont incluses dans le site, ce qui garde les fichiers légers.
import alertTriangle from "@tabler/icons/outline/alert-triangle.svg?raw";
import arrowLeft from "@tabler/icons/outline/arrow-left.svg?raw";
import arrowRight from "@tabler/icons/outline/arrow-right.svg?raw";
import bulb from "@tabler/icons/outline/bulb.svg?raw";
import calendarWeek from "@tabler/icons/outline/calendar-week.svg?raw";
import camera from "@tabler/icons/outline/camera.svg?raw";
import chartBar from "@tabler/icons/outline/chart-bar.svg?raw";
import check from "@tabler/icons/outline/check.svg?raw";
import chevronRight from "@tabler/icons/outline/chevron-right.svg?raw";
import clock from "@tabler/icons/outline/clock.svg?raw";
import download from "@tabler/icons/outline/download.svg?raw";
import edit from "@tabler/icons/outline/edit.svg?raw";
import externalLink from "@tabler/icons/outline/external-link.svg?raw";
import eye from "@tabler/icons/outline/eye.svg?raw";
import eyeOff from "@tabler/icons/outline/eye-off.svg?raw";
import file from "@tabler/icons/outline/file.svg?raw";
import fileText from "@tabler/icons/outline/file-text.svg?raw";
import fileTypePdf from "@tabler/icons/outline/file-type-pdf.svg?raw";
import fileUpload from "@tabler/icons/outline/file-upload.svg?raw";
import folder from "@tabler/icons/outline/folder.svg?raw";
import folderPlus from "@tabler/icons/outline/folder-plus.svg?raw";
import folders from "@tabler/icons/outline/folders.svg?raw";
import headphones from "@tabler/icons/outline/headphones.svg?raw";
import info from "@tabler/icons/outline/info-circle.svg?raw";
import layoutDashboard from "@tabler/icons/outline/layout-dashboard.svg?raw";
import link from "@tabler/icons/outline/link.svg?raw";
import listCheck from "@tabler/icons/outline/list-check.svg?raw";
import lock from "@tabler/icons/outline/lock.svg?raw";
import logout from "@tabler/icons/outline/logout.svg?raw";
import mail from "@tabler/icons/outline/mail.svg?raw";
import microphone from "@tabler/icons/outline/microphone.svg?raw";
import key from "@tabler/icons/outline/key.svg?raw";
import maximize from "@tabler/icons/outline/maximize.svg?raw";
import message from "@tabler/icons/outline/message.svg?raw";
import moon from "@tabler/icons/outline/moon.svg?raw";
import movie from "@tabler/icons/outline/movie.svg?raw";
import notes from "@tabler/icons/outline/notes.svg?raw";
import pencil from "@tabler/icons/outline/pencil.svg?raw";
import photo from "@tabler/icons/outline/photo.svg?raw";
import playerPause from "@tabler/icons/outline/player-pause.svg?raw";
import playerPlay from "@tabler/icons/outline/player-play.svg?raw";
import playerStop from "@tabler/icons/outline/player-stop.svg?raw";
import plus from "@tabler/icons/outline/plus.svg?raw";
import printer from "@tabler/icons/outline/printer.svg?raw";
import qrcode from "@tabler/icons/outline/qrcode.svg?raw";
import refresh from "@tabler/icons/outline/refresh.svg?raw";
import rotate from "@tabler/icons/outline/rotate-clockwise.svg?raw";
import school from "@tabler/icons/outline/school.svg?raw";
import search from "@tabler/icons/outline/search.svg?raw";
import settings from "@tabler/icons/outline/settings.svg?raw";
import shieldLock from "@tabler/icons/outline/shield-lock.svg?raw";
import sparkles from "@tabler/icons/outline/sparkles.svg?raw";
import sun from "@tabler/icons/outline/sun.svg?raw";
import textSize from "@tabler/icons/outline/text-size.svg?raw";
import trash from "@tabler/icons/outline/trash.svg?raw";
import upload from "@tabler/icons/outline/upload.svg?raw";
import user from "@tabler/icons/outline/user.svg?raw";
import x from "@tabler/icons/outline/x.svg?raw";

const ICONS = {
  "alert-triangle": alertTriangle, "arrow-left": arrowLeft, "arrow-right": arrowRight, bulb,
  "calendar-week": calendarWeek, camera, "chart-bar": chartBar, check, "chevron-right": chevronRight, clock,
  eye, "eye-off": eyeOff, info, "list-check": listCheck, lock, pencil,
  download, edit, "external-link": externalLink, file, "file-text": fileText, "file-type-pdf": fileTypePdf, "file-upload": fileUpload,
  folder, "folder-plus": folderPlus, folders, headphones, "layout-dashboard": layoutDashboard, link,
  key, logout, mail, maximize, message, microphone, moon, movie, notes, photo, "player-pause": playerPause, "player-play": playerPlay,
  "player-stop": playerStop, plus, printer, qrcode, refresh, rotate, school, search, settings,
  "shield-lock": shieldLock, sparkles, sun, "text-size": textSize, trash, upload, user, x,
};

/** Renvoie un élément <svg> d'icône (décoratif par défaut). */
export function icon(name, { doodle = false, label = "" } = {}) {
  const tpl = document.createElement("template");
  tpl.innerHTML = (ICONS[name] || ICONS.file).trim();
  const svg = tpl.content.firstElementChild;
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.setAttribute("class", doodle ? "icon doodle" : "icon");
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else {
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
  }
  return svg;
}

export const ICON_NAMES = Object.keys(ICONS);
