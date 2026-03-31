// Component that places cacti where the ground is clicked

export const tapPlaceComponent = {
  schema: {
    min: {default: 6},
    max: {default: 10},
  },


  init() {
    const ground = document.getElementById('ground')
    this.prompt = document.getElementById('promptText')
    this.colorControls = document.getElementById('colorControls')
    const colorBtns = document.querySelectorAll('.color-btn')
    
    // Tracking state
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
                // Clone material so we don't affect other instances (though here there is only one)
                node.material = node.material.clone();
                node.material.color.set(color);
              }
            });
          }
        }
      });
    });

    ground.addEventListener('click', (event) => {
      if (this.hasPlacedModel) {
        return; // Do nothing if already placed
      }

      // Dismiss the prompt text and show color controls.
      this.prompt.style.display = 'none'
      this.colorControls.classList.add('visible')
      
      // Create new entity for the model container
      const newElement = document.createElement('a-entity')

      // Position the model where the user clicked
      const touchPoint = event.detail.intersection.point
      newElement.setAttribute('position', touchPoint)

      // Random Y rotation
      const randomYRotation = Math.random() * 360
      newElement.setAttribute('rotation', `0 ${randomYRotation} 0`)

      // Scale calculations
      const baseScale = Math.floor(Math.random() * (Math.floor(this.data.max) - Math.ceil(this.data.min)) + Math.ceil(this.data.min))
      const finalScale = baseScale * 0.7 

      newElement.setAttribute('visible', 'false')
      newElement.setAttribute('scale', '0.0001 0.0001 0.0001')

      // Interaction features
      newElement.classList.add('cantap')
      
      const modelChild = document.createElement('a-entity')
      this.modelChild = modelChild // Store reference for color updates
      modelChild.setAttribute('gltf-model', this.activeModel)
      modelChild.setAttribute('shadow', { receive: false })
      modelChild.classList.add('cantap')

      // Normalized base scale for duck
      modelChild.setAttribute('scale', '1 1 1')
      
      newElement.appendChild(modelChild)
      this.el.sceneEl.appendChild(newElement)

      this.hasPlacedModel = true;
      this.placedEntity = newElement;

      modelChild.addEventListener('model-loaded', () => {
        newElement.setAttribute('visible', 'true')
        newElement.setAttribute('animation', {
          property: 'scale',
          to: `${finalScale} ${finalScale} ${finalScale}`,
          easing: 'easeOutElastic',
          dur: 800,
        })
      })

      const enableInteractions = () => {
        if (newElement.hasAttribute('xrextras-hold-drag')) return
        newElement.setAttribute('xrextras-hold-drag', 'riseHeight: 0.1')
        newElement.setAttribute('xrextras-two-finger-rotate', '')
        newElement.setAttribute('xrextras-pinch-scale', { min: 0.3, max: 8 })
        newElement.removeAttribute('animation')
      }

      newElement.addEventListener('animationcomplete', enableInteractions)
      setTimeout(enableInteractions, 1000)
    })
  },
}
