/**
 * Babylon.js + 8th Wall AR Scene — Stable & Optimized
 *
 * STABILITY: Camera pose (position + rotation + projection) synced from
 * 8th Wall every frame. Model root lives in the same world coordinate
 * system, so it appears anchored to the real floor.
 *
 * PERFORMANCE: Reduced shadow map, hardware scaling on mobile,
 * throttled DOM updates, simplified materials.
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
    scaleMultiplier: 2.2, // 220% bump requested to match real-world table scale
    hasConfigurator: false,
    prompt: 'Tap the floor to place the Grill',
  },
}

function getActiveProduct() {
  const hash = window.location.hash.replace('#', '').toLowerCase()
  return PRODUCTS[hash] || PRODUCTS.grill
}

// Suppress 8th Wall overlays
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

  // ── State ──
  let engine, scene, camera, shadowGenerator, shadowCatcher
  let root            = null
  let hasPlaced       = false
  let modelSizeXYZ    = new BABYLON.Vector3(1, 1, 1)
  let floorY          = 0
  let lastMeasureTime = 0

  // ── UI ──
  const promptEl              = document.getElementById('promptText')
  const measurementText       = document.getElementById('measurementText')
  const measurementsContainer = document.getElementById('measurementsContainer')
  if (promptEl) promptEl.textContent = product.prompt

  // ═══════════════════════════════════════════════════════════
  // PLACE MODEL
  // ═══════════════════════════════════════════════════════════
  function placeModel(worldPos) {
    floorY = worldPos.y

    BABYLON.SceneLoader.ImportMesh(
      '', '', encodeURI(product.model), scene,
      (meshes) => {
        if (!meshes || meshes.length === 0) {
          hasPlaced = false
          return
        }

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

        // ── SCALE LOGIC (Normalized to Real-World Meters + Multiplier) ──
        const largestDim = Math.max(size.x, size.y, size.z) || 1
        const multiplier = product.scaleMultiplier || 1.0
        const finalScale = (product.targetMetres / largestDim) * multiplier
        root.scaling.setAll(finalScale)

        container.parent = root

        // Face camera
        if (camera) {
          const dx = camera.position.x - root.position.x
          const dz = camera.position.z - root.position.z
          root.rotation.y = Math.atan2(dx, dz)
        }

        // Shadow
        if (shadowCatcher) {
          shadowCatcher.position.y = worldPos.y
          shadowCatcher.isVisible  = true
        }
        meshes.forEach(m => {
          if (m.getTotalVertices && m.getTotalVertices() > 0 && m.isVisible) {
            shadowGenerator.addShadowCaster(m, true)
          }
        })

        // Optimize: freeze mesh world matrices that won't change
        meshes.forEach(m => {
          if (m.isVisible) m.freezeWorldMatrix()
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
  // HIT TESTING
  // ═══════════════════════════════════════════════════════════
  function hitTestSLAM(touchX, touchY) {
    if (isDesktop) {
      const rect = canvas.getBoundingClientRect()
      const ray  = scene.createPickingRay(touchX - rect.left, touchY - rect.top, BABYLON.Matrix.Identity(), camera)
      const plane = BABYLON.Plane.FromPositionAndNormal(BABYLON.Vector3.Zero(), BABYLON.Vector3.Up())
      const dist  = ray.intersectsPlane(plane)
      return dist !== null ? ray.origin.add(ray.direction.scale(dist)) : null
    }

    const rect = xrCanvas.getBoundingClientRect()
    const nx = (touchX - rect.left) / rect.width
    const ny = (touchY - rect.top)  / rect.height

    let hits = []
    try {
      // Allow both planes and feature points for instant responsiveness
      hits = XR8.XrController.hitTest(nx, ny, ['ESTIMATED_SURFACE_PLANE', 'FEATURE_POINT'])
    } catch (e) {
      console.warn('[AR] HitTest error:', e)
    }

    // 1. Try to find a confirmed surface plane first (Horizontally mapped tables/floors)
    const planeHit = hits.find(h => h.type === 'ESTIMATED_SURFACE_PLANE')
    if (planeHit) {
      return new BABYLON.Vector3(planeHit.position.x, planeHit.position.y, planeHit.position.z)
    }

    // 2. Fallback to feature points
    // Prioritize them for initial placement (hasPlaced = false)
    // During dragging, we only allow them if they are below camera height to prevent mid-air jumps
    const isInteraction = currentAction === 'DRAGGING' || currentAction === 'PINCHING'
    if (!hasPlaced || isInteraction) {
      const validPoints = hits.filter(h => h.position.y < (camera.position.y - 0.5))
      if (validPoints.length > 0) {
        return new BABYLON.Vector3(validPoints[0].position.x, validPoints[0].position.y, validPoints[0].position.z)
      }
    }

    // 3. ULTIMATE FALLBACK: Virtual floor at current altitude or y=0
    const ray = scene.createPickingRay(touchX - (rect.left), touchY - (rect.top), BABYLON.Matrix.Identity(), camera)
    const yTarget = hasPlaced ? floorY : 0
    const vPlane = BABYLON.Plane.FromPositionAndNormal(new BABYLON.Vector3(0, yTarget, 0), BABYLON.Vector3.Up())
    const dist = ray.intersectsPlane(vPlane)
    return dist !== null ? ray.origin.add(ray.direction.scale(dist)) : null
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
  // 8TH WALL PIPELINE MODULE
  // ═══════════════════════════════════════════════════════════
  const babylonPipelineModule = {
    name: 'babylonjs-bridge',

    onStart: () => {
      engine = new BABYLON.Engine(canvas, true, {
        preserveDrawingBuffer: true,
        stencil: true,
        alpha: true,
        antialias: !isDesktop ? false : true, // save GPU on mobile
      })

      // Mobile performance: render at lower resolution
      if (!isDesktop) {
        engine.setHardwareScalingLevel(2) // half resolution = 4x faster
      }

      scene = new BABYLON.Scene(engine)
      scene.useRightHandedSystem = true
      scene.autoClear  = false
      scene.clearColor = new BABYLON.Color4(0, 0, 0, 0)

      // Performance: skip unnecessary features
      scene.skipPointerMovePicking = true
      scene.autoClearDepthAndStencil = false

      scene.onBeforeRenderObservable.add(() => {
        engine.clear(new BABYLON.Color4(0, 0, 0, 0), true, true, true)

        // Throttle DOM updates to every 500ms (not every frame!)
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
        // IMPORTANT: detach default controls so Babylon doesn't fight 8th Wall
        camera.inputs.clear()
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

      scene.imageProcessingConfiguration.toneMappingEnabled = true
      scene.imageProcessingConfiguration.toneMappingType =
        BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES

      // ── Shadows (optimized for mobile) ──
      shadowGenerator = new BABYLON.ShadowGenerator(512, dir)  // 512 not 2048!
      shadowGenerator.useExponentialShadowMap = true  // simpler than blur ESM
      shadowGenerator.bias        = 0.001
      shadowGenerator.normalBias  = 0.02

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
        shadowMat.active = true
        shadowMat.alpha = 0.4
      } else {
        // Fallback to extremely subtle standard material if the specific library fails
        shadowMat = new BABYLON.StandardMaterial('shadowMat', scene)
        shadowMat.alpha = 0.05
        shadowMat.specularColor = new BABYLON.Color3(0, 0, 0)
        shadowMat.diffuseColor  = new BABYLON.Color3(0, 0, 0)
        shadowMat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND
      }
      shadowMat.freeze()
      shadowCatcher.material = shadowMat

      // ═════════════════════════════════════════════════════════
      // INTERACTIONS
      // ═════════════════════════════════════════════════════════
      let currentAction     = null
      let activePointers    = new Map()
      let dragOffset        = new BABYLON.Vector3()
      let initialPinchDist  = 0
      let initialPinchScale = 1
      let initialPinchAngle = 0
      let initialRotY       = 0
      let pointerDownX      = 0
      let pointerDownY      = 0
      let pointerDownTime   = 0

      // Desktop zoom
      if (isDesktop) {
        canvas.addEventListener('wheel', ev => {
          if (!root) return
          ev.preventDefault()
          const f = ev.deltaY > 0 ? 0.92 : 1.09
          unfreezeModel()
          root.scaling.setAll(Math.max(root.scaling.x * f, 0.05))
          freezeModel()
        }, { passive: false })
      }

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
              currentAction = 'DRAGGING'
              unfreezeModel()
              if (isDesktop && camera.detachControl) camera.detachControl()
              const gp = pickFloorPlane(ev.clientX, ev.clientY)
              if (gp) {
                dragOffset.set(
                  root.position.x - gp.x,
                  0,
                  root.position.z - gp.z
                )
              } else {
                dragOffset.setAll(0)
              }
            } else if (activePointers.size === 2) {
              currentAction = 'PINCHING'
              const pts = Array.from(activePointers.values())
              const dx  = pts[1].x - pts[0].x
              const dy  = pts[1].y - pts[0].y
              initialPinchDist  = Math.hypot(dx, dy)
              initialPinchScale = root.scaling.x
              initialPinchAngle = Math.atan2(dy, dx)
              initialRotY       = root.rotation.y || 0
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
              if (moved > 10) {
                // Perform a REAL SLAM hit-test during drag for surface snapping (falling off bed to floor)
                const hit = hitTestSLAM(ev.clientX, ev.clientY)
                if (hit) {
                  // X and Z follow the finger
                  root.position.x = hit.x
                  root.position.z = hit.z
                  
                  // Y snaps to the surface found (Gravity/Snapping behavior)
                  // We use a small lerp for Y to prevent jitter if feature points jump
                  root.position.y = BABYLON.Scalar.Lerp(root.position.y, hit.y, 0.2)
                  floorY = root.position.y // Update current floor level
                } else {
                  // Fallback: Use math plane if SLAM tracking is lost temporarily
                  const gp = pickFloorPlane(ev.clientX, ev.clientY)
                  if (gp) {
                    root.position.x = gp.x
                    root.position.z = gp.z
                  }
                }

                // Ensure shadows follow the model's new position and height
                if (shadowCatcher) {
                  shadowCatcher.position.x = root.position.x
                  shadowCatcher.position.z = root.position.z
                  shadowCatcher.position.y = root.position.y
                }
              }
            } else if (currentAction === 'PINCHING' && activePointers.size === 2) {
              const pts = Array.from(activePointers.values())
              const dx  = pts[1].x - pts[0].x
              const dy  = pts[1].y - pts[0].y
              const dist  = Math.hypot(dx, dy)
              const angle = Math.atan2(dy, dx)

              if (initialPinchDist > 10) {
                const s = initialPinchScale * (dist / initialPinchDist)
                root.scaling.setAll(Math.max(0.05, Math.min(s, 10)))
              }
              root.rotation.y = initialRotY + (initialPinchAngle - angle)
            }
            break
          }

          case BABYLON.PointerEventTypes.POINTERUP:
          case BABYLON.PointerEventTypes.POINTEROUT: {
            activePointers.delete(pid)

            if (activePointers.size === 1 && currentAction === 'PINCHING') {
              currentAction = 'DRAGGING'
              const rem = Array.from(activePointers.values())[0]
              const gp  = pickFloorPlane(rem.x, rem.y)
              if (gp) {
                dragOffset.set(root.position.x - gp.x, 0, root.position.z - gp.z)
              }
              break
            }

            if (activePointers.size === 0) {
              // Re-freeze meshes after interaction
              if (currentAction) freezeModel()

              const travel  = Math.hypot(ev.clientX - pointerDownX, ev.clientY - pointerDownY)
              const elapsed = Date.now() - pointerDownTime
              const wasTap  = travel < 20 && elapsed < 500

              if (wasTap && !hasPlaced && currentAction !== 'PINCHING') {
                const worldHit = hitTestSLAM(ev.clientX, ev.clientY)
                if (worldHit) {
                  hasPlaced = true
                  placeModel(worldHit)
                } else if (promptEl) {
                  promptEl.textContent = 'Slowly scan the floor, then tap again'
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

      // Sync projection ONLY when it actually changes to stop phone freezes!
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
