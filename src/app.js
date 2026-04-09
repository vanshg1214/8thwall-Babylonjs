
// Copyright (c) 2022 8th Wall, Inc.
// app.js is the main entry point for your 8th Wall app.
// Path B: Babylon.js + 8th Wall Transformation

import './index.css'
import {initBabylonScene} from './babylon-scene'

// ── ABSOLUTE SCALE CONFIGURATION ──
// Ensuring 1 unit = 1 meter for real-world measurements
const onxrloaded = () => {
  XR8.XrController.configure({scale: 'absolute'})
  
  // Initialize the Babylon Scene logic
  initBabylonScene()
}

// Check for 8th Wall availability
window.XR8 ? onxrloaded() : window.addEventListener('xrloaded', onxrloaded, {once: true})
