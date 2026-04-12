/**
 * Babylon.js + 8th Wall AR Scene — Professional Grade
 *
 * KEY DESIGN DECISIONS:
 * 1. Native DOM touch events for ALL interactions (not Babylon onPointerObservable)
 *    because Babylon's pointer system is unreliable on transparent overlay canvases.
 * 2. Camera pose synced from 8th Wall every frame.
 * 3. Hit-testing uses 8th Wall SLAM (planes + filtered feature points).
 * 4. Scale multiplier for real-world size calibration.
 */

const PRODUCTS = {
  fireplace: {
    model: 'assets/fireplace.glb',
    targetMetres: 1.2,
    scaleMultiplier: 1.0,
    hasConfigurator: true,
    prompt: 'Tap the floor to place the Fireplace',
  },
  grill: {
    model: 'assets/American outdoor grill.glb',
    targetMetres: 1.4,
    scaleMultiplier: 2.2,
    hasConfigurator: false,
    prompt: 'Tap the floor to place the Grill',
  },
}

function getActiveProduct() {
  const hash = window.location.hash.replace('#', '').toLowerCase()
  return PRODUCTS[hash] || PRODUCTS.grill
}

// Suppress 8th Wall coaching overlays
;(function () {
  const s = document.createElement('style')
  s.textContent = `
    .prompt-box-8w,.prompt-button-8w,.coaching-overlay,[class*="coaching"],
    [class*="surface-indicator"],[class*="xr-coaching"],[id*="coaching"],
    canvas[data-xr="coaching"],.xr-grid,.xr8-grid,[class*="grid-overlay"],
    img[src*="poweredby"],#poweredby,.poweredby-container{
      display:none!important;opacity:0!important;pointer-events:none!important;
    }`
  document.head.appendChild(s)
})()

const initBabylonScene = () => {
  const canvas   = document.getElementById('renderCanvas')
  const xrCanvas = document.getElementById('xrCanvas')
  const product  = getActiveProduct()

  const isDesktop = !/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i
    .test(navigator.userAgent)

  // ── Shared State (accessible by all functions in this closure) ──
  let engine, scene, camera, shadowGenerator, shadowCatcher
  let root            = null
  let hasPlaced       = false
  let modelSizeXYZ    = new BABYLON.Vector3(1, 1, 1)
  let floorY          = 0
  let lastMeasureTime = 0

  // Interaction state — declared here so hitTestSLAM can reference it
  let currentAction     = null
  const touches         = new Map()
  let touchStartX       = 0
  let touchStartY       = 0
  let touchStartTime    = 0
  let initialPinchDist  = 0
  let initialPinchScale = 1
  let initialPinchAngle = 0
  let initialRotY       = 0

  // ── UI ──
  const promptEl              = document.getElementById('promptText')
  const measurementText       = document.getElementById('measurementText')
  const measurementsContainer = document.getElementById('measurementsContainer')
  if (promptEl) promptEl.textContent = product.prompt

  // ═══════════════════════════════════════════════════════════
  // HIT TESTING (8th Wall SLAM)
  // ═══════════════════════════════════════════════════════════
  function hitTestSLAM(touchX, touchY) {
    if (isDesktop) {
      const rect = canvas.getBoundingClientRect()
      const ray  = scene.createPickingRay(
        touchX - rect.left, touchY - rect.top,
        BABYLON.Matrix.Identity(), camera
      )
      const plane = BABYLON.Plane.FromPositionAndNormal(
        BABYLON.Vector3.Zero(), BABYLON.Vector3.Up()
      )
      const dist = ray.intersectsPlane(plane)
      return dist !== null ? ray.origin.add(ray.direction.scale(dist)) : null
    }

    // ── Mobile: 8th Wall SLAM hit test ──
    const rect = xrCanvas.getBoundingClientRect()
    const nx = (touchX - rect.left) / rect.width
    const ny = (touchY - rect.top)  / rect.height

    // Estimate where the real floor is: phone is typically held ~1.5m above ground
    const estimatedFloorY = camera.position.y - 1.5

    let hits = []
    try {
      hits = XR8.XrController.hitTest(nx, ny, ['ESTIMATED_SURFACE_PLANE', 'FEATURE_POINT'])
    } catch (e) {
      console.warn('[AR] hitTest error:', e)
    }

    // Priority 1: Confirmed surface plane (this is the gold standard)
    const planeHit = hits.find(h => h.type === 'ESTIMATED_SURFACE_PLANE')
    if (planeHit) {
      console.log('[AR] Hit: SURFACE_PLANE at y=' + planeHit.position.y.toFixed(2))
      return new BABYLON.Vector3(planeHit.position.x, planeHit.position.y, planeHit.position.z)
    }

    // Priority 2: Feature points — STRICT VALIDATION
    // Only accept points that are near the estimated floor level (within ±0.5m)
    // This rejects points on walls, railings, ceilings, and mid-air
    const floorPoints = hits.filter(h => {
      const distFromFloor = Math.abs(h.position.y - estimatedFloorY)
      return distFromFloor < 0.5  // Must be within 50cm of estimated floor
    })
    if (floorPoints.length > 0) {
      // Pick the lowest point (most likely to be the actual floor)
      floorPoints.sort((a, b) => a.position.y - b.position.y)
      console.log('[AR] Hit: FLOOR_POINT at y=' + floorPoints[0].position.y.toFixed(2))
      return new BABYLON.Vector3(
        floorPoints[0].position.x,
        floorPoints[0].position.y,
        floorPoints[0].position.z
      )
    }

    // Priority 3: Virtual floor at estimated floor level
    // This ensures the model always lands on the "ground" even without SLAM data
    const fallbackY = hasPlaced ? floorY : estimatedFloorY
    const ray = scene.createPickingRay(
      touchX - rect.left, touchY - rect.top,
      BABYLON.Matrix.Identity(), camera
    )
    const vPlane = BABYLON.Plane.FromPositionAndNormal(
      new BABYLON.Vector3(0, fallbackY, 0), BABYLON.Vector3.Up()
    )
    const dist = ray.intersectsPlane(vPlane)
    if (dist !== null) {
      console.log('[AR] Hit: VIRTUAL_FLOOR at y=' + fallbackY.toFixed(2))
      return ray.origin.add(ray.direction.scale(dist))
    }
    return null
  }

  // Math-only floor plane pick for dragging (no SLAM noise)
  function pickFloorPlane(screenX, screenY) {
    if (!scene || !camera) return null
    const rect = canvas.getBoundingClientRect()
    const ray  = scene.createPickingRay(
      screenX - rect.left, screenY - rect.top,
      BABYLON.Matrix.Identity(), camera
    )
    const plane = BABYLON.Plane.FromPositionAndNormal(
      new BABYLON.Vector3(0, floorY, 0), BABYLON.Vector3.Up()
    )
    const dist = ray.intersectsPlane(plane)
    return dist !== null ? ray.origin.add(ray.direction.scale(dist)) : null
  }

  // Unfreeze all model meshes (needed before moving root)
  function unfreezeModel() {
    if (!root) return
    root.getChildMeshes(false).forEach(m => m.unfreezeWorldMatrix())
  }

  // Re-freeze all model meshes (after interaction ends)
  function freezeModel() {
    if (!root) return
    root.computeWorldMatrix(true)
    root.getChildMeshes(false).forEach(m => {
      m.computeWorldMatrix(true)
      m.freezeWorldMatrix()
    })
  }

  // ═══════════════════════════════════════════════════════════
  // PLACE MODEL
  // ═══════════════════════════════════════════════════════════
  function placeModel(worldPos) {
    floorY = worldPos.y
    console.log('[AR] Placing model at', worldPos.x.toFixed(2), worldPos.y.toFixed(2), worldPos.z.toFixed(2))

    BABYLON.SceneLoader.ImportMesh(
      '', '', encodeURI(product.model), scene,
      (meshes) => {
        if (!meshes || meshes.length === 0) {
          console.error('[AR] No meshes loaded!')
          hasPlaced = false
          return
        }

        console.log('[AR] Model loaded,', meshes.length, 'meshes')

        // Container at origin to measure bounds
        const container = new BABYLON.TransformNode('model-container', scene)

        meshes.forEach(m => {
          if (m.name !== '__root__' && (!m.parent || m.parent.name === '__root__')) {
            m.setParent(container)
          }
          if (m.material) m.material.freeze()
        })
        meshes.forEach(m => m.computeWorldMatrix(true))

        // Measure visible bounds
        let wMin = new BABYLON.Vector3(1e9, 1e9, 1e9)
        let wMax = new BABYLON.Vector3(-1e9, -1e9, -1e9)
        meshes.forEach(m => {
          if (!m.isVisible || m.visibility <= 0) return
          const nm = (m.name || '').toLowerCase()
          if (nm === '__root__' || nm.includes('shadow') || nm.includes('collider')) return
          m.computeWorldMatrix(true)
          const bb = m.getBoundingInfo().boundingBox
          wMin = BABYLON.Vector3.Minimize(wMin, bb.minimumWorld)
          wMax = BABYLON.Vector3.Maximize(wMax, bb.maximumWorld)
        })
        if (wMin.x > 1e8) {
          meshes.forEach(m => {
            m.computeWorldMatrix(true)
            const bb = m.getBoundingInfo().boundingBox
            wMin = BABYLON.Vector3.Minimize(wMin, bb.minimumWorld)
            wMax = BABYLON.Vector3.Maximize(wMax, bb.maximumWorld)
          })
        }

        const size   = wMax.subtract(wMin)
        const center = wMin.add(wMax).scale(0.5)

        // Shift so local origin = bottom-center
        container.position.set(-center.x, -wMin.y, -center.z)

        // Root anchor at tap position
        root = new BABYLON.TransformNode('ar-root', scene)
        root.position.set(worldPos.x, worldPos.y, worldPos.z)
        root.rotationQuaternion = null
        root.rotation.set(0, 0, 0)

        // Scale to real-world size with calibration multiplier
        const largestDim = Math.max(size.x, size.y, size.z) || 1
        const multiplier = product.scaleMultiplier || 1.0
        const finalScale = (product.targetMetres / largestDim) * multiplier
        root.scaling.setAll(finalScale)
        console.log('[AR] Scale:', finalScale.toFixed(3), '(dim:', largestDim.toFixed(3), 'x', multiplier, ')')

        container.parent = root

        // Face camera
        if (camera) {
          const dx = camera.position.x - root.position.x
          const dz = camera.position.z - root.position.z
          root.rotation.y = Math.atan2(dx, dz)
        }

        // Shadow — only on desktop
        if (shadowCatcher && isDesktop) {
          shadowCatcher.position.set(worldPos.x, worldPos.y, worldPos.z)
          shadowCatcher.isVisible = true
        }
        
        // PERFORMANCE: Disable self-shadowing on mobile entirely.
        // It requires an extra render pass for every mesh and destroys FPS.
        if (shadowGenerator && isDesktop) {
          meshes.forEach(m => {
            if (m.getTotalVertices && m.getTotalVertices() > 0 && m.isVisible) {
              shadowGenerator.addShadowCaster(m, true)
            }
          })
        }

        // Optimize: freeze meshes that won't change
        meshes.forEach(m => {
          if (m.isVisible) {
            m.freezeWorldMatrix()
            m.isPickable = false // PERFORMANCE: Disable picking on individual complex meshes
          }
        })

        modelSizeXYZ = size.clone()

        // UI
        if (promptEl) promptEl.style.display = 'none'
        if (measurementsContainer) {
          measurementsContainer.style.display = 'block'
          measurementsContainer.classList.add('visible')
        }
        const clrCtls = document.getElementById('colorControls')
        if (product.hasConfigurator && clrCtls) {
          clrCtls.classList.add('visible')
          clrCtls.style.display = 'flex'
          setupColorButtons(meshes)
        }
      },
      null,
      (scene, msg) => {
        console.error('[AR] Model load error:', msg)
        hasPlaced = false
      }
    )
  }

  function setupColorButtons(meshes) {
    document.querySelectorAll('.color-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const hex = btn.getAttribute('data-color')
        document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        meshes.forEach(m => {
          if (m.material && m.material.albedoColor) {
            const ln = (m.name || '').toLowerCase()
            if (!ln.includes('glass') && !ln.includes('fire')) {
              m.material.unfreeze()
              m.material.albedoColor = BABYLON.Color3.FromHexString(hex)
              m.material.freeze()
            }
          }
        })
      })
    })
  }

  // ═══════════════════════════════════════════════════════════
  // NATIVE TOUCH INTERACTION SYSTEM
  //
  // This uses raw DOM touchstart/touchmove/touchend events
  // which are 100% reliable on mobile — unlike Babylon's
  // onPointerObservable which breaks on transparent overlay canvases.
  // ═══════════════════════════════════════════════════════════
  function initTouchInteractions() {
    const targetEl = canvas  // The top-layer Babylon canvas

    // Helper: is the touch on a UI element we should ignore?
    function isUITouch(t) {
      const el = document.elementFromPoint(t.clientX, t.clientY)
      return el && (el.closest('.color-controls') || el.closest('.measurements-container'))
    }

    // ── TOUCH START ──
    targetEl.addEventListener('touchstart', (e) => {
      for (const t of e.changedTouches) {
        if (isUITouch(t)) continue
        touches.set(t.identifier, { x: t.clientX, y: t.clientY })
      }

      if (touches.size >= 1 && e.changedTouches.length > 0) {
        const first = e.changedTouches[0]
        touchStartX    = first.clientX
        touchStartY    = first.clientY
        touchStartTime = Date.now()
      }

      // Begin gesture recognition
      if (root && touches.size === 1) {
        currentAction = 'DRAGGING'
        unfreezeModel()
      } else if (root && touches.size >= 2) {
        currentAction = 'PINCHING'
        const pts = Array.from(touches.values())
        const dx  = pts[1].x - pts[0].x
        const dy  = pts[1].y - pts[0].y
        initialPinchDist  = Math.hypot(dx, dy)
        initialPinchScale = root.scaling.x
        initialPinchAngle = Math.atan2(dy, dx)
        initialRotY       = root.rotation.y || 0
      }
    }, { passive: true })

    // ── TOUCH MOVE ──
    targetEl.addEventListener('touchmove', (e) => {
      if (!root || !currentAction) return

      let handled = false
      for (const t of e.changedTouches) {
        if (touches.has(t.identifier)) {
          touches.set(t.identifier, { x: t.clientX, y: t.clientY })
          handled = true
        }
      }
      if (!handled) return

      const pts = Array.from(touches.values())

      if (currentAction === 'DRAGGING' && pts.length === 1) {
        const moved = Math.hypot(pts[0].x - touchStartX, pts[0].y - touchStartY)
        if (moved > 10) {
          // Use math-only floor plane for smooth, stable dragging
          const gp = pickFloorPlane(pts[0].x, pts[0].y)
          if (gp) {
            root.position.x = gp.x
            root.position.z = gp.z
            // Y stays locked to floorY — no SLAM jitter during drag
          }
          if (shadowCatcher) {
            shadowCatcher.position.x = root.position.x
            shadowCatcher.position.z = root.position.z
          }
        }
        e.preventDefault()
      } else if (currentAction === 'PINCHING' && pts.length >= 2) {
        const dx    = pts[1].x - pts[0].x
        const dy    = pts[1].y - pts[0].y
        const dist  = Math.hypot(dx, dy)
        const angle = Math.atan2(dy, dx)

        // Scale (ratio-based, no drift)
        if (initialPinchDist > 10) {
          const s = initialPinchScale * (dist / initialPinchDist)
          root.scaling.setAll(Math.max(0.05, Math.min(s, 10)))
        }

        // Rotation
        root.rotation.y = initialRotY + (initialPinchAngle - angle)
        e.preventDefault()
      }
    }, { passive: false })

    // ── TOUCH END ──
    targetEl.addEventListener('touchend', (e) => {
      for (const t of e.changedTouches) {
        touches.delete(t.identifier)
      }

      // Transition from pinch back to drag
      if (touches.size === 1 && currentAction === 'PINCHING') {
        currentAction = 'DRAGGING'
        return
      }

      // All fingers lifted
      if (touches.size === 0) {
        const lastTouch = e.changedTouches[e.changedTouches.length - 1]
        const travel  = Math.hypot(lastTouch.clientX - touchStartX, lastTouch.clientY - touchStartY)
        const elapsed = Date.now() - touchStartTime

        // ── TAP DETECTION ──
        const wasTap = travel < 20 && elapsed < 500

        if (wasTap && !hasPlaced) {
          console.log('[AR] Tap detected at', lastTouch.clientX, lastTouch.clientY)
          const worldHit = hitTestSLAM(lastTouch.clientX, lastTouch.clientY)
          if (worldHit) {
            console.log('[AR] Hit found, placing model...')
            hasPlaced = true
            placeModel(worldHit)
          } else {
            console.warn('[AR] No hit found at tap location')
            if (promptEl) {
              promptEl.textContent = 'Point at the floor and tap again'
              // Reset text after 2 seconds
              setTimeout(() => {
                if (promptEl && !hasPlaced) promptEl.textContent = product.prompt
              }, 2000)
            }
          }
        }

        // Re-freeze meshes after interaction
        if (currentAction && root) freezeModel()
        currentAction = null
      }
    }, { passive: true })

    // Clean up on cancel
    targetEl.addEventListener('touchcancel', () => {
      touches.clear()
      if (currentAction && root) freezeModel()
      currentAction = null
    }, { passive: true })

    // Desktop: mouse click for tap-to-place
    if (isDesktop) {
      canvas.addEventListener('click', (e) => {
        if (hasPlaced) return
        const worldHit = hitTestSLAM(e.clientX, e.clientY)
        if (worldHit) {
          hasPlaced = true
          placeModel(worldHit)
        }
      })

      canvas.addEventListener('wheel', (ev) => {
        if (!root) return
        ev.preventDefault()
        const f = ev.deltaY > 0 ? 0.92 : 1.09
        unfreezeModel()
        root.scaling.setAll(Math.max(root.scaling.x * f, 0.05))
        freezeModel()
      }, { passive: false })
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 8TH WALL PIPELINE MODULE
  // ═══════════════════════════════════════════════════════════
  const babylonPipelineModule = {
    name: 'babylonjs-bridge',

    onStart: () => {
      engine = new BABYLON.Engine(canvas, true, {
        preserveDrawingBuffer: true,
        stencil: true,
        alpha: true,
        antialias: !isDesktop ? false : true,
      })

      // Mobile performance: render at lower resolution
      if (!isDesktop) {
        engine.setHardwareScalingLevel(2)
      }

      scene = new BABYLON.Scene(engine)
      scene.useRightHandedSystem = true
      scene.autoClear  = false
      scene.clearColor = new BABYLON.Color4(0, 0, 0, 0)
      
      // PERFORMANCE TWEAKS
      scene.skipPointerMovePicking = true
      scene.skipPointerDownPicking = true // Native DOM handles interaction
      scene.skipPointerUpPicking = true
      scene.autoClearDepthAndStencil = false
      scene.blockMaterialDirtyMechanism = true // Freeze materials globally
      if (!isDesktop) BABYLON.SceneOptimizer.OptimizeAsync(scene)

      scene.onBeforeRenderObservable.add(() => {
        engine.clear(new BABYLON.Color4(0, 0, 0, 0), true, true, true)

        // Throttle measurement DOM updates to every 500ms
        if (root && measurementText) {
          const now = performance.now()
          if (now - lastMeasureTime > 500) {
            lastMeasureTime = now
            const sx = (modelSizeXYZ.x * root.scaling.x).toFixed(2)
            const sy = (modelSizeXYZ.y * root.scaling.y).toFixed(2)
            const sz = (modelSizeXYZ.z * root.scaling.z).toFixed(2)
            measurementText.textContent = `SIZE: ${sx}m × ${sy}m × ${sz}m`
          }
        }
      })

      // ── Camera ──
      if (isDesktop) {
        camera = new BABYLON.ArcRotateCamera(
          'arcCam', -Math.PI / 2, Math.PI / 2.5, 5,
          BABYLON.Vector3.Zero(), scene
        )
        camera.attachControl(canvas, true)
        camera.wheelPrecision   = 50
        camera.lowerRadiusLimit = 0.3
        camera.upperRadiusLimit = 30
      } else {
        camera = new BABYLON.FreeCamera('cam', BABYLON.Vector3.Zero(), scene)
        camera.rotationQuaternion = new BABYLON.Quaternion()
        camera.inputs.clear()  // Prevent Babylon from fighting 8th Wall camera
      }
      camera.minZ = 0.05
      camera.maxZ = 500

      // ── Lighting ──
      const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene)
      hemi.intensity = 0.7

      const dir = new BABYLON.DirectionalLight('dir', new BABYLON.Vector3(-1, -2, -1), scene)
      dir.position  = new BABYLON.Vector3(5, 10, 5)
      dir.intensity = 1.0

      try {
        const envMap = BABYLON.CubeTexture.CreateFromPrefilteredData(
          'assets/sanGiuseppeBridge.env', scene
        )
        scene.environmentTexture   = envMap
        scene.environmentIntensity = 0.8
      } catch (e) {
        console.warn('[AR] Env map load failed', e)
      }

      scene.imageProcessingConfiguration.toneMappingEnabled = isDesktop // PERFORMANCE: Disable on mobile
      if (isDesktop) {
        scene.imageProcessingConfiguration.toneMappingType =
          BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES
      }

      // ── Shadows ──
      // PERFORMANCE: Disable shadow generator entirely on mobile.
      if (isDesktop) {
        shadowGenerator = new BABYLON.ShadowGenerator(512, dir)
        shadowGenerator.useExponentialShadowMap = true
        shadowGenerator.bias       = 0.001
        shadowGenerator.normalBias = 0.02
      } else {
        shadowGenerator = null
      }

      if (isDesktop) {
        // Desktop only: create visible shadow-catching ground
        shadowCatcher = BABYLON.MeshBuilder.CreateGround(
          'shadow-catcher', { width: 10, height: 10 }, scene
        )
        shadowCatcher.position.y    = 0
        shadowCatcher.receiveShadows = true
        shadowCatcher.isVisible     = false
        shadowCatcher.isPickable    = false

        let shadowMat
        if (BABYLON.ShadowOnlyMaterial) {
          shadowMat = new BABYLON.ShadowOnlyMaterial('shadowMat', scene)
          shadowMat.activeLight = dir
          shadowMat.alpha = 0.4
        } else {
          shadowMat = new BABYLON.StandardMaterial('shadowMat', scene)
          shadowMat.alpha = 0.05
          shadowMat.specularColor = new BABYLON.Color3(0, 0, 0)
          shadowMat.diffuseColor  = new BABYLON.Color3(0, 0, 0)
          shadowMat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND
        }
        shadowMat.freeze()
        shadowCatcher.material = shadowMat
      } else {
        // Mobile: no shadow catcher at all — eliminates the black plane completely
        shadowCatcher = null
        console.log('[AR] Mobile mode: shadow catcher disabled to prevent black plane artifact')
      }

      // ── Initialize touch interactions ──
      initTouchInteractions()

      console.log('[AR] Scene initialized. Waiting for tap...')
    },

    // ═════════════════════════════════════════════════════════
    // CAMERA SYNC — EVERY FRAME from 8th Wall
    // ═════════════════════════════════════════════════════════
    onUpdate: ({ processCpuResult }) => {
      if (!scene || !camera || isDesktop) return

      const { reality } = processCpuResult
      if (!reality) return

      // Sync position
      if (reality.position) {
        camera.position.x = reality.position.x
        camera.position.y = reality.position.y
        camera.position.z = reality.position.z
      }

      // Sync rotation
      if (reality.rotation) {
        camera.rotationQuaternion.x = reality.rotation.x
        camera.rotationQuaternion.y = reality.rotation.y
        camera.rotationQuaternion.z = reality.rotation.z
        camera.rotationQuaternion.w = reality.rotation.w
      }

      // Sync projection only when it changes (avoids CPU spike)
      if (reality.intrinsics) {
        const intrinsicsStr = reality.intrinsics.join(',')
        if (camera._lastIntrinsics !== intrinsicsStr) {
          camera._lastIntrinsics = intrinsicsStr
          camera.freezeProjectionMatrix(
            BABYLON.Matrix.FromArray(reality.intrinsics)
          )
        }
      }
    },

    onRender: () => {
      if (scene && camera) scene.render()
    },

    onCanvasSizeChange: ({ canvasWidth, canvasHeight }) => {
      if (engine) engine.setSize(canvasWidth, canvasHeight)
    },
  }

  XR8.addCameraPipelineModules([
    XR8.GlTextureRenderer.pipelineModule(),
    window.XRExtras.FullWindowCanvas.pipelineModule(),
    XR8.XrController.pipelineModule(),
    babylonPipelineModule,
    window.XRExtras.Loading.pipelineModule(),
    window.XRExtras.RuntimeError.pipelineModule(),
  ])

  XR8.run({
    canvas: xrCanvas,
    allowedDevices: XR8.XrConfig.device().ANY,
  })
}

export { initBabylonScene }
