/**
 * Babylon.js + 8th Wall AR Scene
 *
 * Tap-to-Place: Model spawns exactly where you tap on the real-world floor.
 * Drag: One-finger to slide model on the floor plane.
 * Pinch: Two-finger to scale and rotate.
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

// ── Suppress 8th Wall coach overlays ──
;(function suppressXROverlays() {
  const style = document.createElement('style')
  style.textContent = `
    .prompt-box-8w, .prompt-button-8w, .coaching-overlay, [class*="coaching"],
    [class*="surface-indicator"], [class*="xr-coaching"], [id*="coaching"],
    canvas[data-xr="coaching"], .xr-grid, .xr8-grid, [class*="grid-overlay"],
    img[src*="poweredby"], #poweredby, .poweredby-container {
      display: none !important; opacity: 0 !important; pointer-events: none !important;
    }
  `
  document.head.appendChild(style)
})()

const initBabylonScene = () => {
  const canvas   = document.getElementById('renderCanvas')
  const xrCanvas = document.getElementById('xrCanvas')
  const product  = getActiveProduct()

  const isDesktop = !/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i
    .test(navigator.userAgent)

  // ── Mutable state ──
  let engine          = null
  let scene           = null
  let camera          = null
  let shadowGenerator = null
  let root            = null
  let shadowCatcher   = null
  let hasPlaced       = false
  let modelSizeXYZ    = new BABYLON.Vector3(1, 1, 1)
  let floorY          = 0   // locked Y after first placement

  // ── UI ──
  const promptEl              = document.getElementById('promptText')
  const measurementText       = document.getElementById('measurementText')
  const measurementsContainer = document.getElementById('measurementsContainer')
  if (promptEl) promptEl.textContent = product.prompt

  // ─────────────────────────────────────────────────────────────
  // LOAD & PLACE MODEL at a specific world position
  // ─────────────────────────────────────────────────────────────
  function placeModel(worldPos) {
    console.log('[AR] Placing model at', worldPos)

    // Compute a floor Y from the hit
    floorY = worldPos.y

    BABYLON.SceneLoader.ImportMesh(
      '', '', encodeURI(product.model), scene,
      (meshes) => {
        if (!meshes || meshes.length === 0) {
          console.warn('[AR] No meshes loaded from', product.model)
          return
        }

        // ── Create a neutral container to measure true bounds ──
        const container = new BABYLON.TransformNode('model-container', scene)
        container.position.setAll(0)
        container.rotationQuaternion = BABYLON.Quaternion.Identity()
        container.scaling.setAll(1)

        meshes.forEach(m => {
          // Re-parent top-level meshes (skip __root__ itself)
          if (m.name !== '__root__' && (!m.parent || m.parent.name === '__root__')) {
            m.setParent(container)
          }
        })
        meshes.forEach(m => m.computeWorldMatrix(true))

        // ── Measure visible geometry bounds ──
        let wMin = new BABYLON.Vector3( 1e9,  1e9,  1e9)
        let wMax = new BABYLON.Vector3(-1e9, -1e9, -1e9)

        meshes.forEach(m => {
          if (!m.isVisible || m.visibility <= 0) return
          const n = (m.name || '').toLowerCase()
          if (n === '__root__' || n.includes('shadow') || n.includes('collider')) return
          m.computeWorldMatrix(true)
          const bb = m.getBoundingInfo().boundingBox
          wMin = BABYLON.Vector3.Minimize(wMin, bb.minimumWorld)
          wMax = BABYLON.Vector3.Maximize(wMax, bb.maximumWorld)
        })

        // If bounds failed (all invisible), fall back to all meshes
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

        // ── Shift container so its local origin = bottom-center of model ──
        // This means when root sits at worldPos, the model base is ON the floor
        container.position.set(-center.x, -wMin.y, -center.z)

        // ── Root anchors to tap position ──
        root = new BABYLON.TransformNode('ar-root', scene)
        root.position.set(worldPos.x, worldPos.y, worldPos.z)

        // ── Scale uniformly to targetMetres ──
        const largestDim = Math.max(size.x, size.y, size.z) || 1
        const sf = product.targetMetres / largestDim
        root.scaling.setAll(sf)

        container.parent = root

        // ── Face camera ──
        if (camera) {
          const dx = camera.position.x - root.position.x
          const dz = camera.position.z - root.position.z
          root.rotation.y = Math.atan2(dx, dz)
        }

        // ── Shadow catcher snaps to hit Y ──
        if (shadowCatcher) {
          shadowCatcher.position.y = worldPos.y
          shadowCatcher.isVisible  = true
        }

        // ── Cast shadows ──
        meshes.forEach(m => {
          if (m.getTotalVertices && m.getTotalVertices() > 0 && m.isVisible) {
            shadowGenerator.addShadowCaster(m, true)
          }
        })

        modelSizeXYZ = size.clone()

        // ── Show UI ──
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

  // ─────────────────────────────────────────────────────────────
  // SLAM HIT TEST — returns { x, y, z } world position or null
  // ─────────────────────────────────────────────────────────────
  function hitTestSLAM(touchX, touchY) {
    if (isDesktop) {
      // Desktop: ray-cast against Y=0 plane
      const rect = canvas.getBoundingClientRect()
      const ray  = scene.createPickingRay(
        touchX - rect.left,
        touchY - rect.top,
        BABYLON.Matrix.Identity(),
        camera
      )
      const plane = BABYLON.Plane.FromPositionAndNormal(
        BABYLON.Vector3.Zero(), BABYLON.Vector3.Up()
      )
      const dist = ray.intersectsPlane(plane)
      return dist !== null ? ray.origin.add(ray.direction.scale(dist)) : null
    }

    // Mobile: use 8th Wall normalised coords [0–1] from xrCanvas, not renderCanvas
    const rect = xrCanvas.getBoundingClientRect()
    const nx = (touchX - rect.left) / rect.width
    const ny = (touchY - rect.top)  / rect.height

    console.log('[AR] hitTest nx=', nx.toFixed(3), 'ny=', ny.toFixed(3))

    let hits = null
    try {
      hits = XR8.XrController.hitTest(nx, ny, ['ESTIMATED_SURFACE_PLANE', 'FEATURE_POINT'])
    } catch (e) {
      console.warn('[AR] hitTest error:', e)
      return null
    }

    if (!hits || hits.length === 0) {
      console.warn('[AR] No SLAM hits at tap point')
      return null
    }

    console.log('[AR] hits:', hits.length, hits[0])

    // Prefer a flat surface plane, fall back to any feature point
    const best = hits.find(h => h.type === 'ESTIMATED_SURFACE_PLANE') || hits[0]
    return new BABYLON.Vector3(best.position.x, best.position.y, best.position.z)
  }

  // Hit-test against mathematical floor plane (for dragging, no SLAM noise)
  function getGroundPick(screenX, screenY, y) {
    if (!scene) return null
    const rect  = canvas.getBoundingClientRect()
    const ray   = scene.createPickingRay(
      screenX - rect.left,
      screenY - rect.top,
      BABYLON.Matrix.Identity(),
      camera
    )
    const plane = BABYLON.Plane.FromPositionAndNormal(
      new BABYLON.Vector3(0, y, 0), BABYLON.Vector3.Up()
    )
    const dist = ray.intersectsPlane(plane)
    return dist !== null ? ray.origin.add(ray.direction.scale(dist)) : null
  }

  // Pick against model meshes
  function hitTestModel(screenX, screenY) {
    if (!root || !scene) return null
    const rect = canvas.getBoundingClientRect()
    const pick = scene.pick(
      screenX - rect.left,
      screenY - rect.top,
      m => m.isVisible && m.isDescendantOf(root)
    )
    return pick && pick.hit ? pick : null
  }

  // ─────────────────────────────────────────────────────────────
  // 8TH WALL PIPELINE MODULE
  // ─────────────────────────────────────────────────────────────
  const babylonPipelineModule = {
    name: 'babylonjs-bridge',

    onStart: () => {
      engine = new BABYLON.Engine(canvas, true, {
        preserveDrawingBuffer: true,
        stencil: true,
        alpha:   true,
        antialias: true,
      })

      scene = new BABYLON.Scene(engine)
      scene.useRightHandedSystem = true
      scene.autoClear            = false
      scene.clearColor           = new BABYLON.Color4(0, 0, 0, 0)

      scene.onBeforeRenderObservable.add(() => {
        engine.clear(new BABYLON.Color4(0, 0, 0, 0), true, true, true)
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
      }
      camera.minZ = 0.01
      camera.maxZ = 1000

      // ── Lighting ──
      const hemi     = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene)
      hemi.intensity = 0.6

      const dir    = new BABYLON.DirectionalLight('dir', new BABYLON.Vector3(-1, -2, -1), scene)
      dir.position = new BABYLON.Vector3(20, 60, 20)
      dir.intensity = 1.2

      try {
        const envMap = BABYLON.CubeTexture.CreateFromPrefilteredData('assets/sanGiuseppeBridge.env', scene)
        scene.environmentTexture   = envMap
        scene.environmentIntensity = 1.0
      } catch (e) {
        console.warn('[AR] Env map load failed', e)
      }

      scene.imageProcessingConfiguration.toneMappingEnabled = true
      scene.imageProcessingConfiguration.toneMappingType    =
        BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES

      // ── Shadows ──
      shadowGenerator = new BABYLON.ShadowGenerator(2048, dir)
      shadowGenerator.useBlurExponentialShadowMap = true
      shadowGenerator.blurKernel                  = 32
      shadowGenerator.bias                        = 0.0001
      shadowGenerator.normalBias                  = 0.02

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
        shadowMat.alpha         = 0.08
        shadowMat.specularColor = new BABYLON.Color3(0, 0, 0)
      }
      shadowCatcher.material = shadowMat

      // ─────────────────────────────────────────────────────────
      // INTERACTION SYSTEM
      // ─────────────────────────────────────────────────────────
      let currentAction     = null
      let activePointers    = new Map()
      let dragOffset        = new BABYLON.Vector3(0, 0, 0)
      let initialPinchDist  = 0
      let initialPinchScale = 1
      let initialPinchAngle = 0
      let initialRotY       = 0
      let pointerDownX      = 0
      let pointerDownY      = 0
      let pointerDownTime   = 0

      // Desktop scroll-to-zoom
      canvas.addEventListener('wheel', ev => {
        if (!root) return
        if (hitTestModel(ev.clientX, ev.clientY)) {
          ev.preventDefault()
          const factor = ev.deltaY > 0 ? 0.92 : 1.09
          root.scaling.setAll(Math.max(root.scaling.x * factor, 0.05))
        }
      }, { passive: false })

      scene.onPointerObservable.add(info => {
        const ev  = info.event
        const pid = ev.pointerId !== undefined ? ev.pointerId : 0

        switch (info.type) {

          case BABYLON.PointerEventTypes.POINTERDOWN: {
            activePointers.set(pid, { x: ev.clientX, y: ev.clientY })
            pointerDownX    = ev.clientX
            pointerDownY    = ev.clientY
            pointerDownTime = Date.now()

            if (!root) break

            if (activePointers.size === 1) {
              if (hitTestModel(ev.clientX, ev.clientY)) {
                currentAction = 'DRAGGING'
                if (isDesktop && camera.detachControl) camera.detachControl(canvas)
                const gp = getGroundPick(ev.clientX, ev.clientY, floorY)
                if (gp) {
                  dragOffset.copyFrom(root.position.subtract(gp))
                  dragOffset.y = 0
                } else {
                  dragOffset.setAll(0)
                }
              }
            } else if (activePointers.size === 2) {
              currentAction     = 'PINCHING'
              const pts         = Array.from(activePointers.values())
              const dx          = pts[1].x - pts[0].x
              const dy          = pts[1].y - pts[0].y
              initialPinchDist  = Math.hypot(dx, dy)
              initialPinchScale = root.scaling.x
              initialPinchAngle = Math.atan2(dy, dx)
              initialRotY       = root.rotation.y || 0
              if (root.rotationQuaternion) {
                const q = root.rotationQuaternion
                initialRotY = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z))
                root.rotationQuaternion = null
                root.rotation.y = initialRotY
              }
            }
            break
          }

          case BABYLON.PointerEventTypes.POINTERMOVE: {
            if (!root || !currentAction) break
            if (activePointers.has(pid)) {
              activePointers.set(pid, { x: ev.clientX, y: ev.clientY })
            }

            if (currentAction === 'DRAGGING' && activePointers.size === 1) {
              const moved = Math.hypot(ev.clientX - pointerDownX, ev.clientY - pointerDownY)
              if (moved > 6) {
                const gp = getGroundPick(ev.clientX, ev.clientY, floorY)
                if (gp) {
                  root.position.x = gp.x + dragOffset.x
                  root.position.z = gp.z + dragOffset.z
                }
              }
            } else if (currentAction === 'PINCHING' && activePointers.size === 2) {
              const pts   = Array.from(activePointers.values())
              const dx    = pts[1].x - pts[0].x
              const dy    = pts[1].y - pts[0].y
              const dist  = Math.hypot(dx, dy)
              const angle = Math.atan2(dy, dx)

              if (initialPinchDist > 10) {
                const rawScale = initialPinchScale * (dist / initialPinchDist)
                root.scaling.setAll(Math.max(0.05, Math.min(rawScale, 10)))
              }
              root.rotation.y = initialRotY + (initialPinchAngle - angle)
            }
            break
          }

          case BABYLON.PointerEventTypes.POINTERUP:
          case BABYLON.PointerEventTypes.POINTEROUT: {
            activePointers.delete(pid)

            // If drop from 2→1, switch back to dragging
            if (activePointers.size === 1 && currentAction === 'PINCHING') {
              currentAction = 'DRAGGING'
              const rem = Array.from(activePointers.values())[0]
              const gp  = getGroundPick(rem.x, rem.y, floorY)
              if (gp) {
                dragOffset.copyFrom(root.position.subtract(gp))
                dragOffset.y = 0
              }
              break
            }

            if (activePointers.size === 0) {
              const travel  = Math.hypot(ev.clientX - pointerDownX, ev.clientY - pointerDownY)
              const elapsed = Date.now() - pointerDownTime
              const wasTap  = travel < 20 && elapsed < 600 && currentAction !== 'PINCHING'

              if (wasTap && !hasPlaced) {
                // ----- TAP TO PLACE -----
                const worldHit = hitTestSLAM(ev.clientX, ev.clientY)
                if (worldHit) {
                  hasPlaced = true
                  placeModel(worldHit)
                } else {
                  // Fallback: show a message to keep scanning
                  console.warn('[AR] Tap hit nothing — keep scanning or move device')
                  if (promptEl) {
                    promptEl.textContent = 'Move your camera around the floor, then tap again'
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

    // ── 8th Wall feeds camera pose every frame ──
    onUpdate: ({ processCpuResult }) => {
      if (!scene || !camera) return
      if (isDesktop) return

      const { reality } = processCpuResult
      if (!reality) return

      if (reality.position) {
        camera.position.set(reality.position.x, reality.position.y, reality.position.z)
      }
      if (reality.rotation) {
        camera.rotationQuaternion.set(
          reality.rotation.x, reality.rotation.y, reality.rotation.z, reality.rotation.w
        )
      }
      if (reality.intrinsics) {
        camera.freezeProjectionMatrix(BABYLON.Matrix.FromArray(reality.intrinsics))
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
