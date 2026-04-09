
// ============================================================
// PRODUCT CONFIGURATION MAP
// Each route maps to a product with its own model, scale, and features
// ============================================================
const PRODUCTS = {
  fireplace: {
    model: '#fireplaceModel',
    targetMetres: 1.2,
    hasConfigurator: true,
    prompt: 'Tap to Place the Fireplace',
  },
  grill: {
    model: '#grillModel',
    targetMetres: 1.2,   // Average outdoor grill ~1.2m tall
    hasConfigurator: false,
    prompt: 'Tap to Place the Grill',
  },
}

// Helper: determine product from URL hash
function getActiveProduct() {
  const hash = window.location.hash.replace('#', '').toLowerCase()
  return PRODUCTS[hash] || PRODUCTS.fireplace  // Default to fireplace
}

export const tapPlaceComponent = {
  schema: {
    min: {default: 0.5},
    max: {default: 1.5},
  },

  init() {
    const ground = document.getElementById('ground')
    this.prompt = document.getElementById('promptText')
    this.colorControls = document.getElementById('colorControls')
    this.measurementsContainer = document.getElementById('measurementsContainer')
    this.measurementText = document.getElementById('measurementText')

    this.hasPlacedModel = false
    this.placedEntity = null
    this.product = getActiveProduct()

    // ── Set prompt text based on product ──
    this.prompt.textContent = this.product.prompt

    // ── Color buttons (only for products with configurator) ──
    if (this.product.hasConfigurator) {
      const buttons = document.querySelectorAll('.color-btn')
      buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
          const color = btn.getAttribute('data-color')
          buttons.forEach(b => b.classList.remove('active'))
          btn.classList.add('active')
          if (this.modelChild) {
            const mesh = this.modelChild.getObject3D('mesh')
            if (mesh) {
              mesh.traverse((node) => {
                if (node.isMesh && node.material) {
                  if (!node.name.toLowerCase().includes('glass') && !node.name.toLowerCase().includes('fire')) {
                    node.material.color.set(color)
                  }
                }
              })
            }
          }
        })
      })
    }

    // ── TAP TO PLACE ──
    ground.addEventListener('click', (event) => {
      if (this.hasPlacedModel) return
      this.prompt.style.display = 'none'

      const newElement = document.createElement('a-entity')
      const touchPoint = event.detail.intersection.point
      newElement.setAttribute('position', touchPoint)
      newElement.setAttribute('rotation', '0 0 0')
      newElement.setAttribute('visible', 'false')
      newElement.setAttribute('scale', '1 1 1')
      newElement.classList.add('cantap')

      const modelChild = document.createElement('a-entity')
      this.modelChild = modelChild
      modelChild.setAttribute('gltf-model', this.product.model)
      modelChild.setAttribute('shadow', {receive: false})
      modelChild.classList.add('cantap')

      newElement.appendChild(modelChild)
      this.el.sceneEl.appendChild(newElement)
      this.hasPlacedModel = true
      this.placedEntity = newElement

      modelChild.addEventListener('model-loaded', () => {
        const mesh = modelChild.getObject3D('mesh')
        if (mesh) {
          // ── CENTERING & GROUNDING ──
          mesh.updateMatrixWorld(true)
          const worldBox = new THREE.Box3().setFromObject(mesh)
          const worldCenter = new THREE.Vector3()
          worldBox.getCenter(worldCenter)
          const localCenter = modelChild.object3D.worldToLocal(worldCenter)
          mesh.position.x -= localCenter.x
          mesh.position.z -= localCenter.z

          const worldMin = worldBox.min.clone()
          const localMin = modelChild.object3D.worldToLocal(worldMin)
          mesh.position.y -= localMin.y

          // ── NORMALIZE SCALE ──
          const size = new THREE.Vector3()
          worldBox.getSize(size)
          const maxDim = Math.max(size.x, size.y, size.z)
          const modelScale = this.product.targetMetres / maxDim
          modelChild.setAttribute('scale', `${modelScale} ${modelScale} ${modelScale}`)

          // ── SHOW UI ──
          // Set initial measurements with proper span structure
          mesh.updateMatrixWorld(true)
          const initSize = new THREE.Vector3()
          new THREE.Box3().setFromObject(mesh).getSize(initSize)
          this.measurementText.innerHTML = `
            <span>SIZE: ${initSize.x.toFixed(2)}m × ${initSize.y.toFixed(2)}m × ${initSize.z.toFixed(2)}m</span>
          `

          if (this.product.hasConfigurator) {
            this.colorControls.classList.add('visible')
          }
          this.measurementsContainer.classList.add('visible')

          // ── PATH A: BABYLON QUALITY REFLECTIONS ──
          this.enhanceGrillTextures(mesh)

          setInterval(() => {
            mesh.updateMatrixWorld(true)
            const currentSize = new THREE.Vector3()
            new THREE.Box3().setFromObject(mesh).getSize(currentSize)
            const sizeSpan = this.measurementText.querySelector('span')
            if (sizeSpan) sizeSpan.innerText = `SIZE: ${currentSize.x.toFixed(2)}m × ${currentSize.y.toFixed(2)}m × ${currentSize.z.toFixed(2)}m`
          }, 100)
        }
        newElement.setAttribute('visible', 'true')
      })

      // ── INTERACTIONS (no hold-drag to prevent jitter) ──
      const enableInteractions = () => {
        if (newElement.hasAttribute('xrextras-pinch-scale')) return
        newElement.setAttribute('xrextras-two-finger-rotate', '')
        newElement.setAttribute('xrextras-pinch-scale', {min: 0.3, max: 8})
      }
      newElement.addEventListener('animationcomplete', enableInteractions)
      setTimeout(enableInteractions, 1000)
    })
  },

  // ============================================================
  // "STUDIO PRO" RENDERING PIPELINE (Babylon Parity)
  // Generates a high-contrast HDR studio map for realistic metals
  // ============================================================
  enhanceGrillTextures(mesh) {
    const renderer = this.el.sceneEl.renderer
    if (!renderer) return

    // ── PMREM GENERATION ──
    const pmremGenerator = new THREE.PMREMGenerator(renderer)
    pmremGenerator.compileEquirectangularShader()

    // ── CREATE A HIGH-CONTRAST "STUDIO" ENVIRONMENT SCENE ──
    const envScene = new THREE.Scene()
    const skyGeo = new THREE.SphereGeometry(100, 32, 32)
    const skyMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide })
    
    // Draw a high-contrast environment directly on canvas (1024x512)
    const canvas = document.createElement('canvas')
    canvas.width = 1024
    canvas.height = 512
    const ctx = canvas.getContext('2d')
    
    // 1. Base dark environment (creates dark contrast in reflections)
    const bg = ctx.createLinearGradient(0, 0, 0, 512)
    bg.addColorStop(0, '#2a2a35')    // Dark cool ceiling
    bg.addColorStop(0.5, '#4a4a5a')  // Mid grey horizon
    bg.addColorStop(0.55, '#5a4a3a') // Warm bounce line
    bg.addColorStop(1, '#151515')    // Very dark floor
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, 1024, 512)

    // 2. Main Key Light (Strong bright reflection on the top left, like Babylon)
    const keyLight = ctx.createRadialGradient(256, 128, 10, 256, 128, 250)
    keyLight.addColorStop(0, '#ffffff')
    keyLight.addColorStop(0.3, '#ddeeff')
    keyLight.addColorStop(1, 'rgba(255, 255, 255, 0)')
    ctx.fillStyle = keyLight
    ctx.fillRect(0, 0, 512, 512)

    // 3. Secondary Warm Fill Light (right side)
    const fillLight = ctx.createRadialGradient(768, 256, 10, 768, 256, 200)
    fillLight.addColorStop(0, '#ffeedd')
    fillLight.addColorStop(1, 'rgba(255, 238, 221, 0)')
    ctx.fillStyle = fillLight
    ctx.fillRect(512, 0, 512, 512)

    const skyTex = new THREE.CanvasTexture(canvas)
    skyTex.mapping = THREE.EquirectangularReflectionMapping
    skyMat.map = skyTex
    envScene.add(new THREE.Mesh(skyGeo, skyMat))

    const envMap = pmremGenerator.fromScene(envScene, 0.04).texture
    envMap.mapping = THREE.EquirectangularReflectionMapping
    pmremGenerator.dispose()

    // ── APPLY REFLECTIONS AND PBR TWEAKS TO THE MODEL ──
    mesh.traverse((node) => {
      if (!node.isMesh || !node.material) return
      const mat = node.material
      
      // Inject the high-contrast studio reflections
      mat.envMap = envMap
      mat.envMapIntensity = 1.6 // Strong intensity for metallic pop
      
      // Gently enforce brushed stainless steel properties
      // (This overrides any flat/matte baked settings from the GLB)
      mat.metalness = 0.85
      mat.roughness = 0.25
      
      // If it's a knob or dial (usually darker/shinier)
      const name = (node.name || '').toLowerCase()
      if (name.includes('knob') || name.includes('dial') || name.includes('button')) {
        mat.metalness = 0.95
        mat.roughness = 0.15
        mat.color.setHex(0xaaaaaa) // Slightly darker chrome look
      } else {
        // Main body - ensure it stays a clean silver tone
        mat.color.setHex(0xe8e8e8) 
      }
      
      mat.needsUpdate = true
    })
  },
}
