// Custom component to track and display dimensions with arrows
const dimensionsIndicatorComponent = {
  schema: {
    baseWidth: {default: 300}, // Length in mm
    baseHeight: {default: 30}, // Width in mm
  },
  init() {
    this.widthLabel = this.el.querySelector('.width-label')
    this.heightLabel = this.el.querySelector('.height-label')
    this.measurementValue = document.getElementById('measurementValue')
  },
  tick() {
    // Dynamically find labels if not already found (needed because they are added later)
    if (!this.widthLabel) this.widthLabel = this.el.querySelector('.width-label')
    if (!this.heightLabel) this.heightLabel = this.el.querySelector('.height-label')

    const currentScale = this.el.object3D.scale.x
    
    const w = Math.round(this.data.baseWidth * currentScale)
    const h = Math.round(this.data.baseHeight * currentScale)

    if (this.widthLabel) this.widthLabel.setAttribute('value', `${w} mm`)
    if (this.heightLabel) this.heightLabel.setAttribute('value', `${h} mm`)
    
    if (this.measurementValue) {
      this.measurementValue.textContent = `L ${w} mm x W ${h} mm`
    }
  }
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
    const colorBtns = document.querySelectorAll('.color-btn')
    
    this.hasPlacedModel = false;
    this.placedEntity = null;
    this.activeModel = '#metalRulerModel';
    this.measurementsContainer = document.getElementById('measurementsContainer')

    // Color button logic
    colorBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = btn.getAttribute('data-color');
        colorBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (this.modelChild) {
          const mesh = this.modelChild.getObject3D('mesh');
          if (mesh) {
            mesh.traverse((node) => {
              if (node.isMesh) {
                node.material = node.material.clone();
                node.material.color.set(color);
              }
            });
          }
        }
      });
    });

    ground.addEventListener('click', (event) => {
      if (this.hasPlacedModel) return

      this.prompt.style.display = 'none'
      this.colorControls.classList.add('visible')
      if (this.measurementsContainer) this.measurementsContainer.classList.add('visible')
      
      const newElement = document.createElement('a-entity')
      const touchPoint = event.detail.intersection.point
      newElement.setAttribute('position', touchPoint)
      newElement.setAttribute('rotation', '0 0 0')
      newElement.setAttribute('visible', 'false')
      // Start at scale 1 (NOT 0.0001) to avoid corrupting measurements
      // We'll handle the entrance animation differently
      newElement.setAttribute('scale', '0.0001 0.0001 0.0001')

      // Dimensions Indicator Component
      newElement.setAttribute('dimensions-indicator', {})

      // Utility to create an arrow line
      const createArrow = (name, length, labelColor) => {
        const arrowGroup = document.createElement('a-entity')
        
        // The Line
        const line = document.createElement('a-box')
        line.setAttribute('scale', `${length} 0.02 0.02`)
        line.setAttribute('material', 'color: #FFFFFF; shader: flat; opacity: 0.8')
        arrowGroup.appendChild(line)

        // End Cap 1
        const cap1 = document.createElement('a-sphere')
        cap1.setAttribute('position', `${-length / 2} 0 0`)
        cap1.setAttribute('radius', '0.04') 
        cap1.setAttribute('material', 'color: #FFFFFF; shader: flat')
        arrowGroup.appendChild(cap1)

        // End Cap 2
        const cap2 = document.createElement('a-sphere')
        cap2.setAttribute('position', `${length / 2} 0 0`)
        cap2.setAttribute('radius', '0.04')
        cap2.setAttribute('material', 'color: #FFFFFF; shader: flat')
        arrowGroup.appendChild(cap2)

        // The Label
        const labelText = document.createElement('a-text')
        labelText.classList.add(`${name}-label`)
        labelText.setAttribute('value', '')
        labelText.setAttribute('align', 'center')
        labelText.setAttribute('color', labelColor)
        labelText.setAttribute('scale', '0.8 0.8 0.8') // Bigger text for clarity
        labelText.setAttribute('side', 'double')
        labelText.setAttribute('position', `0 0.15 0`) // Higher up
        labelText.setAttribute('baseline', 'bottom')
        labelText.setAttribute('wrap-count', '12')
        labelText.setAttribute('font', 'roboto')
        
        if (name === 'height') {
          labelText.setAttribute('rotation', '0 0 -90') 
        }

        arrowGroup.appendChild(labelText)
        return arrowGroup
      }

      // Arrows will be added in model-loaded event once we have accurate dimensions

      newElement.classList.add('cantap')

      const modelChild = document.createElement('a-entity')
      this.modelChild = modelChild
      modelChild.setAttribute('gltf-model', this.activeModel)
      modelChild.setAttribute('shadow', { receive: false })
      modelChild.classList.add('cantap')
      
      newElement.appendChild(modelChild)
      this.el.sceneEl.appendChild(newElement)

      this.hasPlacedModel = true
      this.placedEntity = newElement

      modelChild.addEventListener('model-loaded', () => {
        setTimeout(() => {
          const mesh = modelChild.getObject3D('mesh')
          if (mesh) {
            // ============================================================
            // CRITICAL FIX: Temporarily set parent to scale 1 for accurate
            // measurement. The parent starts at 0.0001 which corrupts
            // THREE.Box3.setFromObject() since it measures in world space.
            // ============================================================
            newElement.object3D.scale.set(1, 1, 1)
            newElement.object3D.updateMatrixWorld(true)

            // Now measure at TRUE native size using a comprehensive traverse
            const box = new THREE.Box3()
            let meshCount = 0
            mesh.traverse((node) => {
              if (node.isMesh) {
                meshCount++
                node.visible = true // Ensure it's not hidden
                if (node.material) {
                  node.material.transparent = false
                  node.material.opacity = 1.0
                }
                node.geometry.computeBoundingBox()
                const childBox = new THREE.Box3().setFromObject(node)
                box.union(childBox)
              }
            })

            if (meshCount === 0) {
              console.warn('No meshes found in model')
            }

            const size = new THREE.Vector3()
            box.getSize(size)
            const maxDim = Math.max(size.x, size.y, size.z)

            // ============================================================
            // MODEL NORMALISATION logic (0.596m)
            // ============================================================
            const TARGET_METRES = 0.596
            const modelScale = TARGET_METRES / maxDim
            
            // Set scale via A-Frame attribute
            modelChild.setAttribute('scale', `${modelScale} ${modelScale} ${modelScale}`)

            // ============================================================
            // LOCAL CENTERING FIX (Absolute Reset)
            // ============================================================
            mesh.updateMatrixWorld(true)
            const worldBox = new THREE.Box3().setFromObject(mesh)
            
            // Get current world center and world floor
            const worldCenter = new THREE.Vector3()
            worldBox.getCenter(worldCenter)
            const worldMin = worldBox.min.clone()
            
            // Convert these world positions to modelChild local space
            const localCenter = modelChild.object3D.worldToLocal(worldCenter)
            const localMin = modelChild.object3D.worldToLocal(worldMin)

            // Adjust mesh position so local center is at 0, 0, 0
            mesh.position.x -= localCenter.x
            mesh.position.z -= localCenter.z
            
            // Adjust mesh position so its bottom is sitting on the floor (Y=0)
            // (Note: localMin now has localCenter subtracted from it)
            mesh.position.y -= localMin.y - 0.002 // Sit slightly above ground

            // Numerical length only
            const lengthLabel = Math.round(maxDim * modelScale * 1000)
            const label = document.getElementById('measurementValue')
            if (label) {
              label.textContent = lengthLabel
            }


            // ============================================================
            // Set outer parent to 1.0 for immediate visibility (no animation)
            // ============================================================
            newElement.object3D.scale.set(1, 1, 1)
          }
          
          newElement.setAttribute('visible', 'true')
        }, 150)
      })




      const enableInteractions = () => {
        if (newElement.hasAttribute('xrextras-hold-drag')) return
        newElement.setAttribute('xrextras-hold-drag', 'riseHeight: 0.1')
        newElement.setAttribute('xrextras-two-finger-rotate', '')
        newElement.setAttribute('xrextras-pinch-scale', { min: 0.3, max: 8 })
      }

      newElement.addEventListener('animationcomplete', enableInteractions)
      setTimeout(enableInteractions, 1000)
    })
  },
}

AFRAME.registerComponent('dimensions-indicator', dimensionsIndicatorComponent)
