// Custom component to track and display dimensions with arrows
const dimensionsIndicatorComponent = {
  schema: {
    baseWidth: {default: 100},
    baseHeight: {default: 100},
    baseDepth: {default: 100},
  },
  init() {
    this.widthLabel = this.el.querySelector('.width-label')
    this.heightLabel = this.el.querySelector('.height-label')
    this.depthLabel = this.el.querySelector('.depth-label')
  },
  tick() {
    const currentScale = this.el.object3D.scale.x
    
    const w = Math.round(this.data.baseWidth * currentScale)
    const h = Math.round(this.data.baseHeight * currentScale)
    const d = Math.round(this.data.baseDepth * currentScale)

    if (this.widthLabel) this.widthLabel.setAttribute('value', `${w}cm`)
    if (this.heightLabel) this.heightLabel.setAttribute('value', `${h}cm`)
    if (this.depthLabel) this.depthLabel.setAttribute('value', `${d}cm`)
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
    this.activeModel = '#duckModel';

    // Color button logic
    colorBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // Don't trigger ground placement
        
        const color = btn.getAttribute('data-color');
        
        // Update button UI
        colorBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Apply color to the model!
        if (this.modelChild) {
          const mesh = this.modelChild.getObject3D('mesh');
          if (mesh) {
            mesh.traverse((node) => {
              if (node.isMesh) {
                // Clone material so we don't affect other instances
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
      
      const newElement = document.createElement('a-entity')
      const touchPoint = event.detail.intersection.point
      newElement.setAttribute('position', touchPoint)
      newElement.setAttribute('rotation', `0 ${Math.random() * 360} 0`)
      newElement.setAttribute('visible', 'false')
      newElement.setAttribute('scale', '0.0001 0.0001 0.0001')

      // Dimensions Indicator Component
      newElement.setAttribute('dimensions-indicator', {baseWidth: 100, baseHeight: 100, baseDepth: 100})

      // Utility to create an arrow line
      const createArrow = (name, position, rotation, labelColor) => {
        const arrowGroup = document.createElement('a-entity')
        arrowGroup.setAttribute('position', position)
        arrowGroup.setAttribute('rotation', rotation)

        // The Line
        const line = document.createElement('a-box')
        line.setAttribute('scale', '1 0.01 0.01')
        line.setAttribute('material', 'color: #FFFFFF; shader: flat; opacity: 0.8')
        arrowGroup.appendChild(line)

        // End Cap 1
        const cap1 = document.createElement('a-box')
        cap1.setAttribute('position', '-0.5 0 0')
        cap1.setAttribute('scale', '0.02 0.1 0.02')
        cap1.setAttribute('material', 'color: #FFFFFF; shader: flat')
        arrowGroup.appendChild(cap1)

        // End Cap 2
        const cap2 = document.createElement('a-box')
        cap2.setAttribute('position', '0.5 0 0')
        cap2.setAttribute('scale', '0.02 0.1 0.02')
        cap2.setAttribute('material', 'color: #FFFFFF; shader: flat')
        arrowGroup.appendChild(cap2)

        // The Label (Container to counter-rotate if needed, but we'll just use billboard-like text)
        const labelText = document.createElement('a-text')
        labelText.classList.add(`${name}-label`)
        labelText.setAttribute('value', '100cm')
        labelText.setAttribute('align', 'center')
        labelText.setAttribute('color', labelColor)
        labelText.setAttribute('scale', '1 1 1')
        labelText.setAttribute('side', 'double') // Visible from both sides
        labelText.setAttribute('position', '0 0.25 0')
        labelText.setAttribute('baseline', 'bottom')
        
        // Use a more reliable font setup
        labelText.setAttribute('font', 'roboto')
        
        // Counter-rotate the text for Height arrow so it stays horizontal
        if (name === 'height') {
          labelText.setAttribute('rotation', '0 0 -90') 
        }

        arrowGroup.appendChild(labelText)
        return arrowGroup
      }

      // Add Width Arrow (X-Axis)
      newElement.appendChild(createArrow('width', '0 1.2 0.6', '0 0 0', '#FFFFFF'))
      
      // Add Height Arrow (Y-Axis) - Vertically aligned
      newElement.appendChild(createArrow('height', '-0.6 0.6 0.6', '0 0 90', '#FFA500'))

      // Add Depth Arrow (Z-Axis) - Along Z
      newElement.appendChild(createArrow('depth', '0.6 1.2 0', '0 90 0', '#00FFFF'))

      // Interactions
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
        newElement.setAttribute('visible', 'true')
        newElement.setAttribute('animation', {
          property: 'scale',
          to: '1 1 1',
          easing: 'easeOutElastic',
          dur: 800,
        })
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
