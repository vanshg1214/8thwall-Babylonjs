# Stable WebAR Architecture for 8th Wall (Single Object Tap & Place + Gestures)

This document contains everything needed to replicate the industry-grade, ultra-stable AR placement and interaction system used in the reference project. You can provide this file to any AI IDE (like Cursor, Copilot, etc.) to apply these identical physics and stability characteristics to your other 8th Wall project.

## 1. Key Stability Concepts Explained (Tell the AI to read this)
- **Native Gestures instead of `xrextras`**: The default `xrextras-gesture-detector` tends to jitter or drift. We use direct `touchstart`/`touchmove` DOM events mapping precisely to `THREE.Raycaster`.
- **True Ground Anchoring (No Floating)**: Using the `_normalizeModel()` function, we temporarily rip scaling and rotation off the parent structures, calculate the absolute true bounding box of the visual meshes, and offset the anchor by exactly `min.y`. This ensures the object always sits perfectly flush on the AR floor.
- **Raycasted Dragging**: We drop a `THREE.Plane` dynamically onto the AR object's current Y height. When dragging, we shoot a raycast from the physical device camera through the finger and onto this invisible 3D plane, locking X and Z coordinates effortlessly while never drifting in Y altitude.
- **Ratio-Based Scaling**: Scaling uses `spread / prevSpread` ratio multiplicatively. Additive delta scaling introduces cumulative floating-point drift, this completely stops that issue.
- **Simultaneous Interaction**: Scaling and Rotation are both mapped simultaneously to two-finger taps.

## 2. Core Interaction Logic (`tap-place.js`)
This is the workhorse component. It registers the tap listener, spawns the model, normalizes the mesh, and controls dragging, rotation, and scaling. 

```javascript
// tap-place.js
export const tapPlaceComponent = {
  schema: {
    minScale: {default: 0.2},
    maxScale: {default: 5.0},
  },

  init() {
    const ground = document.getElementById('ground')
    this.hasPlacedModel = false
    this.placedEntity = null
    this.gesturesEnabled = false

    // Initialize gesture listeners (drag, scale, rotate)
    this._initGestures()

    // Listen for taps on the AR surface
    ground.addEventListener('click', (event) => {
      if (this.hasPlacedModel) return
      this._placeModel(event)
    })
  },

  _placeModel(event) {
    const touchPoint = event.detail.intersection.point
    const newElement = document.createElement('a-entity')

    newElement.setAttribute('position', touchPoint)
    newElement.setAttribute('rotation', `0 0 0`)
    newElement.setAttribute('visible', 'false')
    newElement.setAttribute('scale', '0.0001 0.0001 0.0001')
    newElement.classList.add('cantap') 

    const modelChild = document.createElement('a-entity')
    modelChild.setAttribute('gltf-model', '#myModel') // Replace #myModel with your glTF asset ID
    modelChild.setAttribute('shadow', {receive: false})

    modelChild.addEventListener('model-loaded', () => {
      // Settle flush to the ground before displaying
      this._normalizeModel(modelChild)
      
      newElement.setAttribute('visible', 'true')
      newElement.setAttribute('animation', {
        property: 'scale',
        to: '1 1 1', // Assuming 1 represents the normalized size
        easing: 'easeOutElastic',
        dur: 800,
      })
    })

    newElement.appendChild(modelChild)
    this.el.sceneEl.appendChild(newElement)

    this.hasPlacedModel = true
    this.placedEntity = newElement
    this.gesturesEnabled = false

    // Wait until entrance pop animation finishes before enabling user dragging
    const enable = () => { this.gesturesEnabled = true }
    newElement.addEventListener('animationcomplete', enable)
    setTimeout(enable, 1200)
  },

  _initGestures() {
    this._raycaster = new THREE.Raycaster()
    this._hitPoint = new THREE.Vector3()
    this._hitPlane = new THREE.Plane()
    this._touches = new Map()
    this._prevAngle = null
    this._prevSpread = null

    const isUITouch = (t) => {
      const el = document.elementFromPoint(t.clientX, t.clientY)
      // Replace with any UI elements you want to ignore gestures on
      return el && !!el.closest('.ui-container') 
    }

    const onStart = (e) => {
      Array.from(e.changedTouches).forEach(t => {
        if (!isUITouch(t)) {
          this._touches.set(t.identifier, {x: t.clientX, y: t.clientY})
        }
      })
      this._prevAngle = null
      this._prevSpread = null
    }

    const onMove = (e) => {
      if (!this.gesturesEnabled || !this.placedEntity) return

      let handled = false
      Array.from(e.changedTouches).forEach(t => {
        if (this._touches.has(t.identifier)) {
          this._touches.set(t.identifier, {x: t.clientX, y: t.clientY})
          handled = true
        }
      })
      if (!handled) return

      const pts = Array.from(this._touches.values())

      if (pts.length === 1) {
        // One finger -> Move Object
        this._drag(pts[0])
        e.preventDefault()
      } else if (pts.length >= 2) {
        // Two fingers -> Scale and Rotate Object
        this._pinchRotate(pts[0], pts[1])
        e.preventDefault()
      }
    }

    const onEnd = (e) => {
      Array.from(e.changedTouches).forEach(t => {
        this._touches.delete(t.identifier)
      })
      this._prevAngle = null
      this._prevSpread = null
    }

    document.addEventListener('touchstart', onStart, {passive: true})
    document.addEventListener('touchmove', onMove, {passive: false})
    document.addEventListener('touchend', onEnd, {passive: true})
    document.addEventListener('touchcancel', onEnd, {passive: true})
  },

  _drag(touch) {
    const entity = this.placedEntity
    if (!entity) return

    const camera = this.el.sceneEl.camera
    const canvas = this.el.sceneEl.canvas
    const rect = canvas.getBoundingClientRect()

    const ndcX = ((touch.x - rect.left) / rect.width) * 2 - 1
    const ndcY = -((touch.y - rect.top) / rect.height) * 2 + 1

    this._raycaster.setFromCamera({x: ndcX, y: ndcY}, camera)

    // Raycast against a flat invisible floor matched to the object's altitude
    const modelY = entity.object3D.position.y
    this._hitPlane.set(new THREE.Vector3(0, 1, 0), -modelY)

    if (this._raycaster.ray.intersectPlane(this._hitPlane, this._hitPoint)) {
      entity.object3D.position.x = this._hitPoint.x
      entity.object3D.position.z = this._hitPoint.z
    }
  },

  _pinchRotate(t1, t2) {
    const entity = this.placedEntity
    if (!entity) return

    const angle = Math.atan2(t2.y - t1.y, t2.x - t1.x)
    const spread = Math.hypot(t2.x - t1.x, t2.y - t1.y)

    if (this._prevAngle !== null) {
      // Rotation
      const dAngle = angle - this._prevAngle
      entity.object3D.rotation.y -= dAngle // Clockwise moves clockwise

      // Scale
      const dSpread = spread / this._prevSpread
      const newScale = entity.object3D.scale.x * dSpread
      
      if (newScale >= this.data.minScale && newScale <= this.data.maxScale) {
        entity.object3D.scale.multiplyScalar(dSpread)
      }
    }

    this._prevAngle = angle
    this._prevSpread = spread
  },

  _normalizeModel(entity) {
    const obj = entity.getObject3D('mesh')
    if (!obj) {
      entity.object3D.visible = false
      entity.addEventListener('model-loaded', () => this._normalizeModel(entity), {once: true})
      return
    }

    // Traverse up to clear root transforms so math reflects accurate mesh sizes
    const backups = []
    let curr = entity.object3D
    let root = curr
    while (curr) {
      backups.push({
        obj: curr,
        scale: curr.scale.clone(),
        rotation: curr.rotation.clone()
      })
      curr.scale.set(1, 1, 1)
      curr.rotation.set(0, 0, 0)
      root = curr
      curr = curr.parent
    }

    root.updateMatrixWorld(true)
    const box = new THREE.Box3()
    obj.traverse((child) => {
      if (child.isMesh) {
        box.expandByObject(child)
      }
    })

    if (box.isEmpty()) box.setFromObject(obj)

    const size = new THREE.Vector3()
    box.getSize(size)

    const target = new THREE.Vector3()
    obj.getWorldPosition(target)
    
    // Bottom of the bounding box
    const localBottomY = box.min.y - target.y

    for (const item of backups) {
      item.obj.scale.copy(item.scale)
      item.obj.rotation.copy(item.rotation)
    }

    // Normalize max dimension to exactly 1 A-Frame unit (1 meter)
    const maxDim = Math.max(size.x, size.y, size.z)
    let s = 1.0
    if (maxDim > 0) {
      s = 1.0 / maxDim
      entity.object3D.scale.set(s, s, s)
    }

    // Move up by exact bounding amount so its feet touch altitude "0" perfectly
    entity.object3D.updateMatrixWorld(true)
    entity.object3D.position.y = (-localBottomY * s)
    entity.object3D.visible = true
  }
}
```

## 3. Application Setup (`app.js`)

In the target project's javascript root file (e.g., `app.js`), register this A-Frame component correctly *before* the scene mounts.

```javascript
import { tapPlaceComponent } from './tap-place'

// Register our highly-stable placement & gesture logic
AFRAME.registerComponent('tap-place', tapPlaceComponent)

// Optional: Improves stability feeling by rendering shadows around real objects
AFRAME.registerComponent('xrextras-realtime-occlusion', {
  init() {
    const scene = this.el.sceneEl || this.el
    const setupOcclusion = () => {
      if (window.XR8) {
        XR8.XrController.configure({enableDepth: true})
      }
    }
    if (scene.hasLoaded) {
      scene.addEventListener('realityready', setupOcclusion)
    } else {
      scene.addEventListener('loaded', () => {
        scene.addEventListener('realityready', setupOcclusion)
      })
    }
  },
})
```

## 4. Scene Configuration (`index.html`)

We apply standard lighting and ground bounding box properties. The important part is binding `tap-place` to the `<a-scene>` tag, and designating an element with class `cantap` to serve as our raycasted floor logic.

```html
<!-- Ensure these 8th Wall Meta Tags are correctly applied -->
<meta name="8thwall:renderer" content="aframe:1.5.0"/>

<body>
  <!-- Our Tap-Place Scene Setup -->
  <a-scene
    tap-place
    xrextras-loading
    xrextras-runtime-error
    xrextras-realtime-occlusion
    renderer="colorManagement:true"
    xrweb="
      allowedDevices: any;
      enableDepth: true;
      defaultEnvironmentFogIntensity: 0.5; 
      defaultEnvironmentFloorColor: #FFF;">

    <!-- Declare your models to preload them efficiently -->
    <a-assets>
      <a-asset-item id="myModel" src="assets/my-target-object.glb"></a-asset-item>
    </a-assets>

    <!-- Raycaster for detecting the floor tap -->
    <a-camera
      id="camera"
      position="0 8 8"
      raycaster="objects: .cantap"
      cursor="fuse: false; rayOrigin: mouse;">
    </a-camera>

    <!-- Essential dynamic directional light to give models grounded real shadows -->
    <a-entity
      light="
        type: directional;
        intensity: 0.8;
        castShadow: true;
        shadowMapHeight: 2048;
        shadowMapWidth: 2048;
        shadowCameraTop: 40;
        shadowCameraBottom: -40;
        shadowCameraRight: 40;
        shadowCameraLeft: -40;
        target: #camera"
      xrextras-attach="target: camera; offset: 8 15 4"
      position="1 4.3 2.5"
      shadow>
    </a-entity>
    <a-light type="ambient" intensity="0.5"></a-light>

    <!-- Invisible AR Ground. Class 'cantap' catches cursor raycast -->
    <a-box
      id="ground"
      class="cantap"
      scale="1000 2 1000"
      position="0 -0.99 0"
      material="shader: shadow; transparent: true; opacity: 0.4"
      shadow>
    </a-box>
    
  </a-scene>
</body>
```
