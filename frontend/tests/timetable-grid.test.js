// Itération 6 (C1) : chaque cours est placé à son heure réelle sur la grille.
import { describe, expect, it } from "vitest";
import {
  blocksOfDay, DEFAULT_RANGE, hourLabel, isAllDay, layoutColumns, visibleRange, wallMinutes, weekDays,
} from "../src/lib/timetable-grid.js";

// Heures « flottantes » (sans fuseau) : lues à l'heure locale, comme le navigateur le fait pour un .ics sans fuseau.
const at = (day, hh, mm = 0) => `2026-11-${String(day).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
const ev = (subject, day, [h1, m1], [h2, m2]) => ({ subject, start: at(day, h1, m1), end: at(day, h2, m2) });
const thursday = new Date(2026, 10, 26);

describe("placement à l'heure réelle", () => {
  it("un premier cours à 14 h est placé à 14 h, pas en haut de la journée", () => {
    const { blocks } = blocksOfDay([ev("Maths", 26, [14, 0], [15, 30])], thursday);
    expect(blocks[0]).toMatchObject({ start: 14 * 60, end: 15 * 60 + 30 });
    const range = visibleRange(blocks);
    expect(range.start).toBeGreaterThan(8 * 60); // la grille ne commence pas à 8 h « par défaut »
    expect(range.start).toBeLessThanOrEqual(14 * 60 - 30); // marge au-dessus
  });

  it("demi-heures, quarts d'heure et durées atypiques (45 min, 1 h 30, 2 h)", () => {
    const { blocks } = blocksOfDay([
      ev("A", 26, [8, 15], [9, 0]), ev("B", 26, [9, 30], [11, 0]), ev("C", 26, [13, 45], [15, 45]),
    ], thursday);
    expect(blocks.map((b) => [b.start, b.end - b.start])).toEqual([[495, 45], [570, 90], [825, 120]]);
  });

  it("la plage couvre la semaine avec une marge, arrondie à l'heure", () => {
    const { blocks } = blocksOfDay([ev("A", 26, [8, 15], [9, 0]), ev("B", 26, [16, 0], [17, 40])], thursday);
    expect(visibleRange(blocks)).toEqual({ start: 7 * 60, end: 19 * 60 });
  });

  it("journée sans cours : plage par défaut 8 h – 18 h", () => {
    expect(visibleRange(blocksOfDay([], thursday).blocks)).toEqual(DEFAULT_RANGE);
  });

  it("un seul cours court : la grille garde au moins 4 h", () => {
    const r = visibleRange(blocksOfDay([ev("A", 26, [14, 0], [14, 45])], thursday).blocks);
    expect(r.end - r.start).toBeGreaterThanOrEqual(240);
    expect(r.start).toBeLessThanOrEqual(14 * 60);
    expect(r.end).toBeGreaterThanOrEqual(14 * 60 + 45);
  });
});

describe("cours qui se chevauchent", () => {
  it("sont mis côte à côte ; des cours qui se touchent ne se chevauchent pas", () => {
    const { blocks } = blocksOfDay([
      ev("TD groupe 1", 26, [10, 0], [12, 0]), ev("TD groupe 2", 26, [10, 0], [11, 0]),
      ev("Labo", 26, [11, 0], [12, 0]), ev("Anglais", 26, [12, 0], [13, 0]),
    ], thursday);
    const placed = Object.fromEntries(layoutColumns(blocks).map((b) => [b.event.subject, [b.col, b.cols]]));
    expect(placed["TD groupe 1"]).toEqual([0, 2]);
    expect(placed["TD groupe 2"]).toEqual([1, 2]);
    expect(placed.Labo).toEqual([1, 2]); // reprend la colonne libérée à 11 h
    expect(placed.Anglais).toEqual([0, 1]); // commence quand les autres finissent : pleine largeur
  });

  it("trois cours en même temps : trois colonnes", () => {
    const { blocks } = blocksOfDay([ev("A", 26, [9, 0], [10, 0]), ev("B", 26, [9, 0], [10, 0]), ev("C", 26, [9, 30], [10, 30])], thursday);
    expect(layoutColumns(blocks).map((b) => b.cols)).toEqual([3, 3, 3]);
  });
});

describe("cas limites", () => {
  it("évènement « toute la journée » à part, sans étirer la grille sur 24 h", () => {
    const day = { subject: "Sortie", start: "2026-11-26T00:00:00", end: "2026-11-27T00:00:00" };
    expect(isAllDay(day)).toBe(true);
    const { blocks, allDay } = blocksOfDay([day, ev("Maths", 26, [10, 0], [11, 0])], thursday);
    expect(allDay).toHaveLength(1);
    expect(blocks).toHaveLength(1);
    expect(blocksOfDay([day], new Date(2026, 10, 27)).allDay).toHaveLength(0); // pas le lendemain
  });

  it("cours qui passe minuit : coupé proprement sur chaque jour", () => {
    const night = { subject: "Observation", start: at(26, 22, 0), end: at(27, 1, 0) };
    expect(blocksOfDay([night], thursday).blocks[0]).toMatchObject({ start: 22 * 60, end: 24 * 60 });
    expect(blocksOfDay([night], new Date(2026, 10, 27)).blocks[0]).toMatchObject({ start: 0, end: 60 });
  });

  it("changement d'heure (dernier dimanche d'octobre) : l'heure affichée reste l'heure de l'horloge", () => {
    // Le 25 octobre 2026, la France passe de 3 h à 2 h : un cours 14 h – 16 h dure 2 h à l'horloge.
    const sunday = new Date(2026, 9, 25);
    const lesson = { subject: "Stage", start: "2026-10-25T14:00:00", end: "2026-10-25T16:00:00" };
    expect(blocksOfDay([lesson], sunday).blocks[0]).toMatchObject({ start: 840, end: 960 });
    expect(wallMinutes(new Date("2026-03-29T09:30:00"))).toBe(570); // passage à l'heure d'été
  });

  it("heure avec fuseau : affichée à l'heure locale de l'appareil", () => {
    const utc = { subject: "Visio", start: "2026-11-26T13:00:00Z", end: "2026-11-26T14:00:00Z" };
    const local = new Date(utc.start);
    expect(blocksOfDay([utc], local).blocks[0].start).toBe(local.getHours() * 60 + local.getMinutes());
  });

  it("libellés d'heures et jours de la semaine (week-end seulement s'il y a cours)", () => {
    expect(hourLabel(14 * 60)).toBe("14 h");
    expect(hourLabel(8 * 60 + 15)).toBe("8 h 15");
    const monday = new Date(2026, 10, 23);
    expect(weekDays(monday, [], thursday).map((d) => d.index)).toEqual([0, 1, 2, 3, 4]);
    expect(weekDays(monday, [ev("Colle", 28, [9, 0], [10, 0])], thursday).map((d) => d.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
