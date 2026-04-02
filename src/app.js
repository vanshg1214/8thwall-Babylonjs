// Copyright (c) 2022 8th Wall, Inc.
//
// app.js is the main entry point for your 8th Wall app. Code here will execute after head.html
// is loaded, and before body.html is loaded.

import './index.css'

// ============================================================
// CONFIGURE ABSOLUTE SCALE (1 unit = 1 meter)
// This must run before XR8.addCameraPipelineModules() (internally called by a-scene)
// ============================================================
const onxrloaded = () => {
  XR8.XrController.configure({scale: 'absolute'})
}
window.XR8 ? onxrloaded() : window.addEventListener('xrloaded', onxrloaded, {once: true})

// Register custom A-Frame components in app.js before the scene in body.html has loaded.
import {tapPlaceComponent} from './tap-place'
AFRAME.registerComponent('tap-place', tapPlaceComponent)

