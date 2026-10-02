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
| `parts/orc-head.glb` | pieza rígida: cabeza de `creep.cleaver` | Imagen generada con un prompt propio (ver «Piezas rígidas» en `docs/ASSET_PROMPT.md`), convertida a 3D con **TRELLIS.2**, y preparada con `tools/glb-part-prepare.mjs` (soldado, simplificado a 886 triángulos, recortado el collar, textura descartada) | Proyecto | Propia — obra derivada de un prompt nuestro, sin material de terceros. TRELLIS es MIT y no reclama derechos sobre la salida | 2026-09-30 | https://huggingface.co/spaces/microsoft/TRELLIS.2 |
| `parts/orc-torso.glb` | pieza rígida: torso de `creep.cleaver` | Imagen generada con un prompt propio (ver «Piezas rígidas» en `docs/ASSET_PROMPT.md`), convertida a 3D con **TRELLIS.2**, y preparada con `tools/glb-part-prepare.mjs` (soldado 96.526 a 43.175 vértices, simplificado a 1.470 triángulos, textura descartada) | Proyecto | Propia — obra derivada de un prompt nuestro, sin material de terceros. TRELLIS es MIT y no reclama derechos sobre la salida | 2026-09-30 | https://huggingface.co/spaces/microsoft/TRELLIS.2 |
| `parts/orc-cleaver.glb` | pieza rígida: arma de `creep.cleaver` | Imagen generada con un prompt propio (ver «Piezas rígidas» en `docs/ASSET_PROMPT.md`), convertida a 3D con **TRELLIS.2**, y preparada con `tools/glb-part-prepare.mjs` (soldado 69.055 a 46.557 vértices, simplificado a 594 triángulos, textura descartada) | Proyecto | Propia — obra derivada de un prompt nuestro, sin material de terceros. TRELLIS es MIT y no reclama derechos sobre la salida | 2026-09-30 | https://huggingface.co/spaces/microsoft/TRELLIS.2 |
| `parts/orc-arm.glb`, `parts/orc-hips.glb`, `parts/orc-thigh.glb`, `parts/orc-shin.glb` | piezas rígidas: miembros de `creep.cleaver` | Dos imágenes generadas con prompts propios (ver «Piezas rígidas» en `docs/ASSET_PROMPT.md`), convertidas a 3D con **TRELLIS.2** y troceadas con `tools/glb-part-prepare.mjs`. TRELLIS devolvió un cuerpo entero en ambos casos; el brazo y las tres piezas de pierna se recortaron de ahí | Proyecto | Propia — obra derivada de prompts nuestros, sin material de terceros. TRELLIS es MIT y no reclama derechos sobre la salida | 2026-10-01 | https://huggingface.co/spaces/microsoft/TRELLIS.2 |
| `orc.glb` | `creep.cleaver` | Descargado gratuito de CGTrader, articulo 725386. Paquete con `Base mesh.fbx` (49 submallas, 136 huesos, dos hachas atadas a `ork_right_axe_1` y `ork_left_axe_1`), `axe.fbx` suelta, 12 FBX de animacion y texturas TGA de 4096. Reconstruido con `tools/fbx-to-creep.mjs`: esqueleto unico por nombre de hueso, soldado 54.468 a 12.784 vertices, diezmado a 3.595 triangulos en dos grupos de material, clips recortados a su ventana util, texturas a 1024 (cuerpo) y 512 (hachas) | Autor de CGTrader, sin verificar | **PENDIENTE DE VERIFICAR.** Gratuito no implica libre. La licencia Royalty Free de CGTrader permite uso comercial en videojuegos **pero exige que un tercero no pueda extraer el modelo**, y un juego de navegador sirve sus assets al cliente. **No publicar hasta resolver esto** | 2026-10-02 | https://www.cgtrader.com/items/725386 |
| `mutant.glb` | `creep.duskrunner` (Devorador) | Descargado de CGTrader (el fichero suelto del pack se llama `cgtrader_optimized_mutant01_Run01.fbx`). Malla base riggeada mas 19 FBX de animacion mas tres juegos de texturas. Reconstruido con `tools/fbx-to-creep.mjs mutant`: esqueleto unico por nombre de hueso, soldado 29.844 a 5.816 vertices, diezmado a 3.400 triangulos, huesos de 70 a 41, textura a 1024, clips recortados | Autor de CGTrader, sin verificar | **PENDIENTE DE VERIFICAR**, igual que el orco: la licencia Royalty Free de CGTrader permite uso comercial en videojuegos pero exige que un tercero no pueda extraer el modelo, y un juego de navegador sirve sus assets al cliente. **No publicar hasta resolver esto** | 2026-10-02 | https://www.cgtrader.com |
| `erika.glb` | `creep.spinebolt` (Arquera) | **Mixamo** (Adobe): personaje `Erika Archer With Bow Arrow` descargado With Skin, mas seis animaciones descargadas Without Skin (idle, walk, run, attack, death, hit). Convertido con `tools/fbx-to-creep.mjs erika`: esqueleto unico por nombre, soldado 63.012 a 12.424 vertices, diezmado a 3.380 triangulos con presupuesto por material, texturas incrustadas empaquetadas en un atlas de 1024 | Adobe / Mixamo | Mixamo se distribuye para uso libre, **incluido el comercial**, con cuenta gratuita de Adobe, y sin la clausula que bloquea a CGTrader. **Verificar los terminos antes de publicar**: no se ha leido el contrato, solo se conoce de referencia | 2026-10-02 | https://www.mixamo.com |
| `hero-knight.glb` | hero.bulwark (candidato) | **KayKit Character Pack: Adventurers 1.0**, fichero `Characters/gltf/Knight.glb`, recortado a 7 clips con `tools/glb-keep-clips.mjs` | Kay Lousberg | **CC0 1.0 Universal** — uso personal, educativo y comercial; atribución no obligatoria (el autor la agradece) | 2026-09-29 | https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0 |

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
| **KayKit** (Kay Lousberg) | CC0 1.0 | No requerida, agradecida | Personajes riggeados y animados en glTF, un solo atlas de gradiente por personaje. Los paquetes gratuitos son Adventurers y Skeletons; los de pago traen además fuentes `.blend`. Verificar la licencia de cada paquete al descargar |
| **Quaternius** | CC0 o **QAL** según el paquete | No requerida | Personajes low-poly estilizados, encajan con la cámara cenital. **Ojo**: algunos paquetes recientes ya no son CC0 sino licencia propia QAL. Comprobar uno por uno |
| **Kenney** | CC0 | No requerida | Props y kits modulares |
| **Poly Pizza** | CC0 / CC-BY | Según asset | Verificar una por una |
| **Sketchfab** | Variable | Según asset | **Comprobar siempre**: mucho contenido es «personal use only» |
| **Mixamo** | Gratis con cuenta Adobe | No | Animaciones humanoides con retargeting |
| **Generación 3D por IA** | Nuestra | No | Prompt propio; anotar la herramienta y la fecha |

## Prohibido

- Cualquier cosa extraída de otro juego, incluidos ports y «remasters» de fans.
- Assets marcados «personal use», «non-commercial» o sin licencia declarada.
- Nombres, insignias o vestimenta reconocibles de IP existente.
