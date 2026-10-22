# Demo guide

Run `pnpm install && pnpm playground` from the repository root. The server listens on `http://127.0.0.1:5176`; the [demo index](http://127.0.0.1:5176/demos.html) is the easiest entry point. These demos run from source and use local sample data.

The demo index and component gallery have a visible 中文 / EN switch. The choice follows the gallery link and is saved for the next visit. To pick a language directly, add `?lang=zh` or `?lang=en` to `demos.html`, or `&lang=zh|en` to the gallery URL. The gallery keeps its current section and control state when you switch.

The canvas scenes are designed for a desktop-sized browser window. In a narrow sidebar pane, the fixed-size gallery Blocks shrink to fit; open the demo in a full browser window to inspect controls and text.

| Scene | URL | Source |
| --- | --- | --- |
| Spatial application, starting at login | [`?scene=spatial`](http://127.0.0.1:5176/?scene=spatial) | [`Spatial.vue`](../examples/playground/src/scenes/Spatial.vue), [`wms/`](../examples/playground/src/wms) |
| Six-view spatial overview | [`?scene=spatial&stage=overview`](http://127.0.0.1:5176/?scene=spatial&stage=overview) | Same |
| Component gallery | [`?scene=gallery`](http://127.0.0.1:5176/?scene=gallery) | [`Gallery.vue`](../examples/playground/src/gallery/Gallery.vue) |
| Sign-up form | [`?scene=signup`](http://127.0.0.1:5176/?scene=signup) | [`SignUp.vue`](../examples/playground/src/scenes/SignUp.vue) |
| World surface | [`?scene=world`](http://127.0.0.1:5176/?scene=world) | [`World.vue`](../examples/playground/src/scenes/World.vue) |
| Screen + world | [`?scene=both`](http://127.0.0.1:5176/?scene=both) | [`Both.vue`](../examples/playground/src/scenes/Both.vue) |

The spatial app has six named Blocks: `orders`, `dashboard`, `network`, `twin`, `inventory`, and `settings`. Add `&focus=<name>` to jump into one without the login step. The gallery's sections are `primitives`, `buttons`, `toggles`, `inputs`, `dialog`, and `containers`; add `&focus=<section>` to open one directly. The gallery controls are interactive: try buttons, switches, text entry, dialogs, and the fused glass toolbar.

The standalone sign-up demo places its glass form in world space so you can inspect its thickness: **left-drag pans**, **right-drag rotates**, and **the wheel zooms**. Click without dragging to use the form controls. The combined screen + world scene still uses a screen-layer sign-up form.

Useful shared parameters:

| Parameter | Effect |
| --- | --- |
| `quality=high|medium|low|minimal|auto` | Select a render quality tier; `auto` is adaptive. |
| `scheme=light|dark` | Select the color scheme. |
| `motion=frozen|live` | Freeze or enable UI motion. |
| `webgl` | Force the WebGL2 backend instead of WebGPU detection. |
| `hud=0` | Hide the performance HUD. |

`pnpm playground:build` writes a static multi-page build to `examples/playground/dist`, including `demos.html` and the canvas demo. The public [sign-up concept](https://fortbrain.ai/concepts/glassui-signup/) uses the same interactive playground build, with editable fields and camera controls. The [six-view concept](https://fortbrain.ai/concepts/glassui-spatial/) opens its spatial overview.
