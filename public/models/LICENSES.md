# Licencias de assets

Registro obligatorio. **Un asset sin licencia anotada aquí no se usa**, sin
excepciones — ver la política de assets en `ARCHITECTURE.md`.

Cada fila debe poder justificarse ante un tercero. Si no puedes enlazar la
licencia, el asset no entra.

## Modelos (`public/models/`)

| Fichero | Personaje | Fuente | Autor | Licencia | Fecha | Enlace |
| --- | --- | --- | --- | --- | --- | --- |
| `bulwark.glb` | hero.bulwark | Generado por IA (Trellis-2, imagen→3D) a partir de una imagen generada con un prompt propio | Proyecto | Propia — obra derivada de un prompt nuestro, sin material de terceros | 2026-08-13 | n/a |
| `core.glb` | landmark: Núcleo | Ídem | Proyecto | Propia | 2026-08-13 | n/a |
| `shop-hero.glb` | landmark: tienda T1 | Ídem | Proyecto | Propia | 2026-08-13 | n/a |
| `shop-sabotage.glb` | landmark: tienda T2 | Ídem | Proyecto | Propia | 2026-08-13 | n/a |
| `portal.glb` | landmark: portales de aparición (4 instancias) | Imagen generada con Nano Banana Pro a partir de un prompt propio (ver `docs/ASSET_PROMPT.md`), convertida a 3D con **TRELLIS.2** (Microsoft, MIT) en Hugging Face Spaces | Proyecto | Propia — obra derivada de un prompt nuestro, sin material de terceros. TRELLIS es MIT y no reclama derechos sobre la salida | 2026-08-16 | https://huggingface.co/spaces/microsoft/TRELLIS.2 |
| `fountain.glb` | landmark: Fuente | Imagen generada con Nano Banana Pro a partir de un prompt propio (ver `docs/ASSET_PROMPT.md`), convertida a 3D con **TRELLIS.2** (Microsoft, MIT) en Hugging Face Spaces | Proyecto | Propia — obra derivada de un prompt nuestro, sin material de terceros. TRELLIS es MIT y no reclama derechos sobre la salida | 2026-08-15 | https://huggingface.co/spaces/microsoft/TRELLIS.2 |

**Nota sobre `bulwark.glb`**: 96.650 triángulos, sin esqueleto ni animaciones.
Está en el manifiesto para validar el camino de carga, no porque un héroe
estático sea entregable. Ver `docs/AI_ASSET_WORKFLOW.md`.

## Animaciones

| Fichero | Fuente | Licencia | Notas |
| --- | --- | --- | --- |
| _(vacío)_ | | | |

## Texturas e iconos

Las texturas de terreno y materiales se siguen **generando por código**
(`src/art/`), así que no aparecen aquí. Solo se registran los ficheros que
importamos.

| Fichero | Fuente | Autor | Licencia | Fecha | Enlace |
| --- | --- | --- | --- | --- | --- |
| _(vacío)_ | | | | | |

---

## Fuentes admitidas

| Fuente | Licencia habitual | Atribución | Notas |
| --- | --- | --- | --- |
| **Quaternius** | CC0 | No requerida | Personajes low-poly estilizados, encajan con la cámara cenital |
| **Kenney** | CC0 | No requerida | Props y kits modulares |
| **Poly Pizza** | CC0 / CC-BY | Según asset | Verificar una por una |
| **Sketchfab** | Variable | Según asset | **Comprobar siempre**: mucho contenido es «personal use only» |
| **Mixamo** | Gratis con cuenta Adobe | No | Animaciones humanoides con retargeting |
| **Generación 3D por IA** | Nuestra | No | Prompt propio; anotar la herramienta y la fecha |

## Prohibido

- Cualquier cosa extraída de otro juego, incluidos ports y «remasters» de fans.
- Assets marcados «personal use», «non-commercial» o sin licencia declarada.
- Nombres, insignias o vestimenta reconocibles de IP existente.
