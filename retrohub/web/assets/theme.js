/* Setzt Farbschema und Bewegungsreduktion vor dem ersten Zeichnen (vermeidet Aufblitzen). */
(function () {
  'use strict';
  var pref = 'system', motion = false;
  try { pref = JSON.parse(localStorage.getItem('rh.theme')) || 'system'; motion = JSON.parse(localStorage.getItem('rh.reduceMotion')) === true; } catch (e) { /* Speicher nicht verfügbar */ }
  var dark = pref === 'dark' || (pref === 'system' && !(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches));
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  if (motion) document.documentElement.setAttribute('data-motion', 'reduce');
}());
