/**
 * Babylon.js + 8th Wall AR Scene — Rock-Solid Ground Placement
 *
 * STABILITY ARCHITECTURE:
 * - Model is placed once in SLAM world-space and NEVER re-positioned automatically.
 * - Camera pose is synced from 8th Wall every frame (position + rotation + projection).
 * - The model stays fixed because it lives in the same world coordinate system.
 * - Floor Y is locked at placement time. All dragging uses a mathematical plane at that Y.
 *
 * INTERACTIONS (after placement):
 * - One finger drag: slides model on the locked floor plane
 * - Two finger pinch: scale up/down
 * - Two finger twist: rotate around Y axis
 * - Desktop: scroll to zoom, click-drag to move, right-click orbit
 */

const PRODUCTS = {
  fireplace: {
    model: 'assets/fireplace.glb',
    targetMetres: 1.2,
    hasConfigurator: true,
    prompt: 'Tap the floor to place the Fireplace',
  },
  grill: {
    model: 'assets/American outdoor grill.glb',
    targetMetres: 1.4,
    hasConfigurator: false,
    prompt: 'Tap the floor to place the Grill',
  },
}

function getActiveProduct() {
  const hash = window.location.hash.replace('#', '').toLowerCase()
  return PRODUCTS[hash] || PRODUCTS.grill
}

// Suppress 8th Wall coaching/branding overlays
;(function suppressXROverlays() {
  const s = document.createElement('style')
  s.textContent = `
    .prompt-box-8w, .prompt-button-8w, .coaching-overlay, [class*="coaching"],
    [class*="surface-indicator"], [class*="xr-coaching"], [id*="coaching"],
    canvas[data-xr="coaching"], .xr-grid, .xr8-grid, [class*="grid-overlay"],
    img[src*="poweredby"], #poweredby, .poweredby-container {
      display:none!important;opacity:0!important;pointer-events:none!important;
    }
  `
  document.head.appendChild(s)
})()

const initBabylonScene = () => {
  const canvas  = document.getElementById('renderCanvas')
  const xrCanvas = document.getElementById('xrCanvas')
  const product = getActiveProduct()

  const isDesktop = !/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i
    .test(navigator.userAgent)

  // ── Core scene state ──
  let engine          = null
  let scene           = null
  let camera          = null
  let shadowGenerator = null
  let root            = null       // TransformNode anchoring model in world space
  let shadowCatcher   = null
  let hasPlaced       = false
  let modelSizeXYZ    = new BABYLON.Vector3(1, 1, 1)
  let floorY          = 0          // locked world-Y of the floor after first hit
  let projectionFrozen = false

  // ── UI handles ──
  const promptEl              = document.getElementById('promptText')
  const measurementText       = document.getElementById('measurementText')
  const measurementsContainer = document.getElementById('measurementsContainer')
  if (promptEl) promptEl.textContent = product.prompt

  // ═══════════════════════════════════════════════════════════════
  // PLACE MODEL — called once after a successful SLAM hit test
  // ═══════════════════════════════════════════════════════════════
  function placeModel(worldPos) {
    console.log('[AR] Placing model at world position:', worldPos.x.toFixed(3), worldPos.y.toFixed(3), worldPos.z.toFixed(3))

    floorY = worldPos.y

    BABYLON.SceneLoader.ImportMesh(
      '', '', encodeURI(product.model), scene,
      (meshes) => {
        if (!meshes || meshes.length === 0) {
          console.warn('[AR] No meshes loaded')
          hasPlaced = false
          return
        }

        // ── Container for measuring true geometry bounds ──
        const container = new BABYLON.TransformNode('model-container', scene)
        container.position.setAll(0)
        container.rotationQuaternion = BABYLON.Quaternion.Identity()
        container.scaling.setAll(1)

        meshes.forEach(m => {
          if (m.name !== '__root__' && (!m.parent || m.parent.name === '__root__')) {
            m.setParent(container)
          }
        })
        meshes.forEach(m => m.computeWorldMatrix(true))

        // ── Compute visible geometry bounds ──
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

        // Fallback if all meshes were invisible
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

        // Shift container so local origin = bottom-center of mesh
        // When root.position = worldPos, model base sits ON the floor
        container.position.set(-center.x, -wMin.y, -center.z)

        // ── Root anchor — this is the ONLY thing that determines world position ──
        root = new BABYLON.TransformNode('ar-root', scene)
        root.position.set(worldPos.x, worldPos.y, worldPos.z)
        // Ensure we use euler-rotation (not quaternion) for clean Y-rotation
        root.rotationQuaternion = null
        root.rotation.set(0, 0, 0)

        // Scale to target real-world size
        const largestDim = Math.max(size.x, size.y, size.z) || 1
        const sf = product.targetMetres / largestDim
        root.scaling.setAll(sf)

        container.parent = root

        // Face camera on spawn
        if (camera) {
          const dx = camera.position.x - root.position.x
          const dz = camera.position.z - root.position.z
          root.rotation.y = Math.atan2(dx, dz)
        }

        // Position shadow catcher at floor
        if (shadowCatcher) {
          shadowCatcher.position.y = worldPos.y
          shadowCatcher.isVisible  = true
        }

        // Register shadow casters
        meshes.forEach(m => {
          if (m.getTotalVertices && m.getTotalVertices() > 0 && m.isVisible) {
            shadowGenerator.addShadowCaster(m, true)
          }
        })

        modelSizeXYZ = size.clone()

        // Update UI
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

        console.log('[AR] Model placed and anchored. Scale:', sf.toFixed(4), 'FloorY:', floorY.toFixed(4))
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
              m.material.albedoColor = BABYLON.Color3.FromHexString(hex)
            }
          }
        })
      })
    })
  }

  // ═══════════════════════════════════════════════════════════════
  // HIT TESTING
  // ═══════════════════════════════════════════════════════════════

  // SLAM hit test for initial placement — returns BABYLON.Vector3 or null
  function hitTestSLAM(touchX, touchY) {
    if (isDesktop) {
      const rect = canvas.getBoundingClientRect()
      const ray  = scene.createPickingRay(
        touchX - rect.left, touchY - rect.top,
        BABYLON.Matrix.Identity(), camera
      )
      const plane = BABYLON.Plane.FromPositionAndNormal(BABYLON.Vector3.Zero(), BABYLON.Vector3.Up())
      const dist  = ray.intersectsPlane(plane)
      return dist !== null ? ray.origin.add(ray.direction.scale(dist)) : null
    }

    // 8th Wall normalised coords — use xrCanvas since that's where 8th Wall runs
    const rect = xrCanvas.getBoundingClientRect()
    const nx = (touchX - rect.left) / rect.width
    const ny = (touchY - rect.top)  / rect.height

    let hits = null
    try {
      hits = XR8.XrController.hitTest(nx, ny, ['ESTIMATED_SURFACE_PLANE', 'FEATURE_POINT'])
    } catch (e) {
      console.warn('[AR] hitTest error:', e)
      return null
    }

    if (!hits || hits.length === 0) return null

    // Prefer a confirmed surface, fall back to feature points
    const best = hits.find(h => h.type === 'ESTIMATED_SURFACE_PLANE') || hits[0]
    return new BABYLON.Vector3(best.position.x, best.position.y, best.position.z)
  }

  // Mathematical ray-vs-plane for smooth dragging (no SLAM noise)
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

  // ═══════════════════════════════════════════════════════════════
  // 8TH WALL PIPELINE MODULE
  // ═══════════════════════════════════════════════════════════════
  const babylonPipelineModule = {
    name: 'babylonjs-bridge',

    onStart: () => {
      engine = new BABYLON.Engine(canvas, true, {
        preserveDrawingBuffer: true,
        stencil: true,
        alpha: true,
        antialias: true,
      })

      scene = new BABYLON.Scene(engine)
      scene.useRightHandedSystem = true
      scene.autoClear  = false
      scene.clearColor = new BABYLON.Color4(0, 0, 0, 0)

      // Clear before each frame to ensure transparent overlay
      scene.onBeforeRenderObservable.add(() => {
        engine.clear(new BABYLON.Color4(0, 0, 0, 0), true, true, true)

        // Live measurements
        if (!root || !measurementText) return
        const sx = (modelSizeXYZ.x * root.scaling.x).toFixed(2)
        const sy = (modelSizeXYZ.y * root.scaling.y).toFixed(2)
        const sz = (modelSizeXYZ.z * root.scaling.z).toFixed(2)
        measurementText.innerHTML = `<span>SIZE: ${sx}m × ${sy}m × ${sz}m</span>`
      })

      // ── Camera ──
      if (isDesktop) {
        camera = new BABYLON.ArcRotateCamera('arcCam', -Math.PI / 2, Math.PI / 2.5, 5, BABYLON.Vector3.Zero(), scene)
        camera.attachControl(canvas, true)
        camera.wheelPrecision   = 50
        camera.lowerRadiusLimit = 0.3
        camera.upperRadiusLimit = 30
      } else {
        camera = new BABYLON.FreeCamera('cam', BABYLON.Vector3.Zero(), scene)
        camera.rotationQuaternion = new BABYLON.Quaternion()
        // Detach any default camera input on mobile — 8th Wall drives the camera
        camera.detachControl()
      }
      camera.minZ = 0.01
      camera.maxZ = 1000

      // ── Lighting ──
      const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene)
      hemi.intensity = 0.6

      const dir = new BABYLON.DirectionalLight('dir', new BABYLON.Vector3(-1, -2, -1), scene)
      dir.position  = new BABYLON.Vector3(20, 60, 20)
      dir.intensity = 1.2

      try {
        const envMap = BABYLON.CubeTexture.CreateFromPrefilteredData('assets/sanGiuseppeBridge.env', scene)
        scene.environmentTexture   = envMap
        scene.environmentIntensity = 1.0
      } catch (e) {
        console.warn('[AR] Env map load failed', e)
      }

      scene.imageProcessingConfiguration.toneMappingEnabled = true
      scene.imageProcessingConfiguration.toneMappingType =
        BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES

      // ── Shadows ──
      shadowGenerator = new BABYLON.ShadowGenerator(2048, dir)
      shadowGenerator.useBlurExponentialShadowMap = true
      shadowGenerator.blurKernel  = 32
      shadowGenerator.bias        = 0.0001
      shadowGenerator.normalBias  = 0.02

      shadowCatcher = BABYLON.MeshBuilder.CreatePlane('shadow-catcher', { size: 1000 }, scene)
      shadowCatcher.rotation.x    = Math.PI / 2
      shadowCatcher.position.y    = 0
      shadowCatcher.receiveShadows = true
      shadowCatcher.isVisible     = false
      shadowCatcher.isPickable    = false

      let shadowMat
      if (typeof BABYLON.ShadowOnlyMaterial !== 'undefined') {
        shadowMat = new BABYLON.ShadowOnlyMaterial('shadowMat', scene)
      } else {
        shadowMat = new BABYLON.StandardMaterial('shadowMat', scene)
        shadowMat.alpha = 0.08
        shadowMat.specularColor = new BABYLON.Color3(0, 0, 0)
      }
      shadowCatcher.material = shadowMat

      // ═════════════════════════════════════════════════════════
      // TOUCH / POINTER INTERACTION SYSTEM
      //
      // On mobile:
      //   Before placement: tap = place model
      //   After  placement: 1-finger drag = slide on floor
      //                     2-finger pinch = scale
      //                     2-finger twist = rotate
      //
      // On desktop:
      //   Before placement: click = place model
      //   After  placement: left-drag on model = slide
      //                     scroll on model = zoom
      //                     ArcRotate camera handles orbit otherwise
      // ═════════════════════════════════════════════════════════
      let currentAction     = null   // null | 'DRAGGING' | 'PINCHING'
      let activePointers    = new Map()
      let dragOffset        = new BABYLON.Vector3(0, 0, 0)
      let initialPinchDist  = 0
      let initialPinchScale = 1
      let initialPinchAngle = 0
      let initialRotY       = 0
      let pointerDownX      = 0
      let pointerDownY      = 0
      let pointerDownTime   = 0

      // Desktop scroll-to-zoom on model
      canvas.addEventListener('wheel', ev => {
        if (!root) return
        ev.preventDefault()
        const factor = ev.deltaY > 0 ? 0.92 : 1.09
        root.scaling.setAll(Math.max(root.scaling.x * factor, 0.05))
      }, { passive: false })

      scene.onPointerObservable.add(info => {
        const ev  = info.event
        const pid = ev.pointerId !== undefined ? ev.pointerId : 0

        switch (info.type) {

          // ── POINTER DOWN ──
          case BABYLON.PointerEventTypes.POINTERDOWN: {
            activePointers.set(pid, { x: ev.clientX, y: ev.clientY })
            pointerDownX    = ev.clientX
            pointerDownY    = ev.clientY
            pointerDownTime = Date.now()

            if (!root) break  // model not placed yet, wait for tap-up

            if (activePointers.size === 1) {
              // Start DRAGGING — on mobile we don't require hit-testing the model
              // since accuracy is low on phones; any 1-finger drag moves the model
              currentAction = 'DRAGGING'
              if (isDesktop && camera.detachControl) camera.detachControl(canvas)

              const gp = pickFloorPlane(ev.clientX, ev.clientY)
              if (gp) {
                dragOffset.copyFrom(root.position.subtract(gp))
                dragOffset.y = 0
              } else {
                dragOffset.setAll(0)
              }

            } else if (activePointers.size === 2) {
              // Switch to PINCHING (scale + rotate)
              currentAction = 'PINCHING'
              const pts         = Array.from(activePointers.values())
              const dx          = pts[1].x - pts[0].x
              const dy          = pts[1].y - pts[0].y
              initialPinchDist  = Math.hypot(dx, dy)
              initialPinchScale = root.scaling.x
              initialPinchAngle = Math.atan2(dy, dx)
              initialRotY       = root.rotation.y || 0
            }
            break
          }

          // ── POINTER MOVE ──
          case BABYLON.PointerEventTypes.POINTERMOVE: {
            if (!root || !currentAction) break
            if (activePointers.has(pid)) {
              activePointers.set(pid, { x: ev.clientX, y: ev.clientY })
            }

            if (currentAction === 'DRAGGING' && activePointers.size === 1) {
              const moved = Math.hypot(ev.clientX - pointerDownX, ev.clientY - pointerDownY)
              if (moved > 8) {
                const gp = pickFloorPlane(ev.clientX, ev.clientY)
                if (gp) {
                  root.position.x = gp.x + dragOffset.x
                  root.position.z = gp.z + dragOffset.z
                  // Y stays locked at floorY — never changes
                }
              }
            } else if (currentAction === 'PINCHING' && activePointers.size === 2) {
              const pts   = Array.from(activePointers.values())
              const dx    = pts[1].x - pts[0].x
              const dy    = pts[1].y - pts[0].y
              const dist  = Math.hypot(dx, dy)
              const angle = Math.atan2(dy, dx)

              // Scale
              if (initialPinchDist > 10) {
                const rawScale = initialPinchScale * (dist / initialPinchDist)
                root.scaling.setAll(Math.max(0.05, Math.min(rawScale, 10)))
              }
              // Rotate
              root.rotation.y = initialRotY + (initialPinchAngle - angle)
            }
            break
          }

          // ── POINTER UP ──
          case BABYLON.PointerEventTypes.POINTERUP:
          case BABYLON.PointerEventTypes.POINTEROUT: {
            activePointers.delete(pid)

            // 2→1 finger: transition from pinch to drag seamlessly
            if (activePointers.size === 1 && currentAction === 'PINCHING') {
              currentAction = 'DRAGGING'
              const rem = Array.from(activePointers.values())[0]
              const gp  = pickFloorPlane(rem.x, rem.y)
              if (gp) {
                dragOffset.copyFrom(root.position.subtract(gp))
                dragOffset.y = 0
              }
              break
            }

            if (activePointers.size === 0) {
              const travel  = Math.hypot(ev.clientX - pointerDownX, ev.clientY - pointerDownY)
              const elapsed = Date.now() - pointerDownTime
              const wasTap  = travel < 20 && elapsed < 500

              // ── TAP TO PLACE (only before model is placed) ──
              if (wasTap && !hasPlaced && currentAction !== 'PINCHING') {
                const worldHit = hitTestSLAM(ev.clientX, ev.clientY)
                if (worldHit) {
                  hasPlaced = true
                  placeModel(worldHit)
                } else {
                  console.warn('[AR] No floor detected — scan more of the surface')
                  if (promptEl) {
                    promptEl.textContent = 'Slowly scan the floor, then tap again'
                  }
                }
              }

              currentAction = null
              if (isDesktop && camera.attachControl) camera.attachControl(canvas, true)
            }
            break
          }
        }
      })
    },

    // ═════════════════════════════════════════════════════════════
    // CAMERA SYNC — 8th Wall feeds position/rotation/projection
    //
    // CRITICAL FOR STABILITY:
    // - We update the camera's VIEW (pos + rot) every frame from SLAM
    // - We freeze the PROJECTION matrix from 8th Wall's intrinsics
    // - The model root lives in the SAME world coordinate system
    // - Therefore the model appears perfectly anchored in reality
    // ═════════════════════════════════════════════════════════════
    onUpdate: ({ processCpuResult }) => {
      if (!scene || !camera || isDesktop) return

      const { reality } = processCpuResult
      if (!reality) return

      // Sync camera position from SLAM
      if (reality.position) {
        camera.position.set(
          reality.position.x,
          reality.position.y,
          reality.position.z
        )
      }

      // Sync camera rotation from SLAM
      if (reality.rotation) {
        camera.rotationQuaternion.set(
          reality.rotation.x,
          reality.rotation.y,
          reality.rotation.z,
          reality.rotation.w
        )
      }

      // Set projection matrix from device intrinsics (only once, then frozen)
      if (reality.intrinsics) {
        if (!projectionFrozen) {
          camera.freezeProjectionMatrix(
            BABYLON.Matrix.FromArray(reality.intrinsics)
          )
          projectionFrozen = true
        }
      }
    },

    onRender: () => {
      if (scene && camera) scene.render()
    },

    onCanvasSizeChange: ({ canvasWidth, canvasHeight }) => {
      if (engine) engine.setSize(canvasWidth, canvasHeight)
      // If canvas resizes, allow projection to re-freeze with new intrinsics
      projectionFrozen = false
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
