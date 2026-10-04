# Prompt para generación de assets (Nano Banana / similar)

Documento para pasar a una IA de imagen. Está escrito para **nuestra** tecnología
concreta, no en genérico.

---

## Antes de nada: qué puede y qué no puede darnos una IA de imagen

Es importante que esto quede claro para no perder tiempo ni créditos.

Nuestros personajes son **mallas 3D generadas por código** (`src/units/build/`),
con esqueleto procedural y texturas PBR sintetizadas en tiempo de carga. Una IA
de imagen genera **imágenes 2D**. Por tanto:

| Tipo de asset | ¿Usable directamente? | Cómo lo usamos |
| --- | --- | --- |
| **Retratos de héroe / jefe** | ✅ Sí, tal cual | Van al hueco de retrato del HUD y a las fichas de selección, que hoy muestran un escudo procedural |
| **Iconos de habilidad** | ✅ Sí, tal cual | Sustituyen los SVG en línea de la barra Q/W/E/R |
| **Hojas de referencia ortográfica** | ⚠️ Indirectamente | No se importan; **yo las leo** para parametrizar el constructor de personajes (proporciones, siluetas, paletas) |
| **Texturas de material** | ⚠️ Con condiciones | Solo si son perfectamente *tileables* y sin luz horneada |
| **Modelos 3D listos para jugar** | ⚠️ Parcialmente, ver abajo | Una IA de *imagen* no los produce, pero una imagen suya pasada por **TRELLIS.2** sí da una malla usable. Así se hicieron el Núcleo, la fuente, las tiendas y los portales |
| **Piezas rígidas de personaje** | ✅ Sí, vía TRELLIS.2 | Cabezas, cascos, cuernos, colmillos, armas, alas. Ver la sección «Piezas rígidas» al final |

Lo de mayor retorno inmediato son **retratos e iconos**. Las hojas de referencia
son las de mayor retorno a medio plazo, porque dirigen el arte 3D.

---

## Restricción legal (obligatoria en todos los prompts)

El proyecto no puede contener nada derivado de Warcraft III ni de ningún otro
juego. Incluir **siempre** esta línea:

> Original character design. Do not imitate, reference or resemble any existing
> game franchise, in particular Warcraft, World of Warcraft, Dota or League of
> Legends. No copyrighted logos, insignia or trade dress.

---

## Especificaciones técnicas comunes

- **Formato:** PNG.
- **Fondo:** transparente (canal alfa real) para retratos, iconos y hojas de
  personaje. Nunca un fondo recortado a blanco.
- **Tamaños:** potencias de dos, obligatorio.
  - Retratos: `512 × 512`
  - Iconos: `256 × 256`
  - Hojas de referencia: `1024 × 1024`
  - Texturas: `1024 × 1024`
- **Iluminación:** neutra y frontal, **sin sombras proyectadas ni luz dramática
  horneada**. Nuestro motor ilumina en tiempo real; una sombra pintada encima se
  ve mal cuando el sol del juego viene del otro lado.
- **Cámara:** ortográfica y de frente para hojas de referencia. Sin perspectiva
  ni escorzo.
- **Contorno:** silueta limpia y legible, sin desenfoque en los bordes.

---

## Dirección de arte del proyecto

Pegar este bloque como preámbulo en **todos** los prompts:

```
Stylised dark-fantasy game art. Chunky, exaggerated, readable proportions:
oversized shoulders, weapons and heads; heavy boots; strong tapering toward the
waist. Hand-painted look with visible brush structure, NOT photorealism and NOT
smooth 3D render. Mid-saturation palette — colour comes from lighting, so keep
albedo restrained. Clear silhouette readable at a glance from a top-down camera
40 metres away. Neutral frontal lighting, no cast shadows, no ground plane, no
background scenery. Transparent background.
Original character design. Do not imitate, reference or resemble any existing
game franchise, in particular Warcraft, World of Warcraft, Dota or League of
Legends. No copyrighted logos, insignia or trade dress.
```

---

## 1. Retratos de héroe y jefe — `512 × 512`

Formato: busto, de los hombros hacia arriba, ligeramente girado (3/4), mirada
hacia cámara. Encuadre centrado con algo de aire.

### `portrait_bulwark.png`
```
[PREÁMBULO DE ARTE]
Bust portrait, 3/4 view, shoulders up. A heavy armoured guardian: broad
trapezoid silhouette, enormous layered pauldrons, a helm with a narrow vertical
visor slit glowing faint amber. Weathered dark steel with brass trim, deep navy
cloth beneath. Stoic, immovable presence. Palette: desaturated steel blue,
gunmetal, muted gold accents.
```

### `portrait_oracle.png`
```
[PREÁMBULO DE ARTE]
Bust portrait, 3/4 view, shoulders up. A veiled seer: tall narrow silhouette, a
wide fanned collar rising behind the head, face half-hidden under a hood with two
small warm floating lights where the eyes would be. Layered violet and deep plum
robes with pale bone-coloured trim. Serene, unsettling. Palette: muted violet,
plum, cold bone white.
```

### `portrait_talon.png`
```
[PREÁMBULO DE ARTE]
Bust portrait, 3/4 view, shoulders up. A lean marksman: narrow upright
silhouette, deep hood shadowing the upper face, a short cloak clasped at one
shoulder and the opposite shoulder left bare for the draw. The upper limb of a
tall recurve bow rises past the head on one side -- it must break the outline and
be the one shape the portrait is read by. Watchful, still, about to loose.
Palette: forest green, worn leather brown, pale gold, a faint mint green glow.
```

### `portrait_vesper.png`
```
[PREÁMBULO DE ARTE]
Bust portrait, 3/4 view, shoulders up. A serene healer: the silhouette widens
like a bell below the chest, and a thin unbroken ring of warm light floats
horizontally above her head, not touching it. A shepherd's crook rests against
one shoulder with a small lantern hanging from it. Hooded robe in bone white
with warm brown and gold trim. Calm, radiant, maternal. Palette: bone white,
warm brown, gold, warm cream glow.
```

### `portrait_marrow_titan.png`
```
[PREÁMBULO DE ARTE]
Bust portrait, 3/4 view, shoulders up. A colossal asymmetric bone giant: one
shoulder far larger than the other, a crown of jagged horns, no visible eyes —
only sockets with a dim cold glow. Cracked bone plating over dark sinew.
Menacing, ancient, top-heavy. Palette: bleached bone, ash grey, cold cyan glow.
```

---

## 2. Iconos de habilidad — `256 × 256`

Formato: símbolo único, centrado, sin marco ni borde (el marco lo pone nuestra
interfaz). Debe leerse a 40 px.

**Hoy son SVG en línea** (`src/ui/icons.ts`): un trazo sobre rejilla 24×24 que usa
`currentColor`, y de eso dependen el tinte dorado, el estado deshabilitado y el
barrido de enfriamiento, que son CSS puro. Un PNG pintado no se puede tintar. No
es bloqueante — el enfriamiento pasa a ser un filtro CSS sobre la imagen y el
deshabilitado una desaturación — pero hay que hacerlo al integrarlos, no después.

Plantilla:
```
[PREÁMBULO DE ARTE]
Single centred ability icon on transparent background. Bold simple symbol,
readable when scaled down to 40 pixels. No frame, no border, no text.
Flat 2D icon illustration, not a 3D render, not a photograph.
Subject: <DESCRIPCIÓN>
```

Son **16 iconos, uno por habilidad**. Hoy hay dos reutilizados que no deben
seguir siéndolo: `spark` lo comparten Sello de éter y Luz punzante, y `unbroken`
lo comparten Bastión inquebrantable y Alba.

### Bulwark, Guardián del Vado — acero azulado, gris metal, oro apagado

| Fichero | Habilidad | Descripción |
| --- | --- | --- |
| `icon_bulwark_q.png` | Embate de escudo | a heavy round shield driven forward head-on, radiating impact cracks across its face, warm amber sparks at the rim |
| `icon_bulwark_w.png` | Grito de anclaje | a visored helm front-on with mouth open, three concentric sound arcs pushing outward, a small heavy anchor forming the chin, muted gold |
| `icon_bulwark_e.png` | Muro de contención | interlocking stone blocks forming a low barrier seen head-on, cool grey with a faint blue protective rim light along the top edge |
| `icon_bulwark_r.png` | Bastión inquebrantable | a shield boss splitting open with a shockwave ring bursting outward and a warm restorative glow welling from the crack, radiant gold and white |

### Oracle — violeta apagado, ciruela, blanco hueso frío

Los cuatro de esta sección estaban descritos en una versión anterior del doc y
**ya no correspondían a las habilidades**: se rediseñaron después. Estas son las
actuales.

| Fichero | Habilidad | Descripción |
| --- | --- | --- |
| `icon_oracle_q.png` | Cadena de relámpagos | a forked violet lightning bolt branching into three separate arcs that leap to small glowing points, each arc thinner and dimmer than the one before |
| `icon_oracle_w.png` | Tormenta de escarcha | jagged ice shards falling into a shallow circular area seen in slight perspective, pale cyan shards over a violet ground ring |
| `icon_oracle_e.png` | Sello de éter | a circular rune seal lying flat on the ground, its lines cracking apart from the centre with violet light bursting up through the breaks |
| `icon_oracle_r.png` | Meteoro del umbral | a burning meteor falling steeply from the upper left, violet flame trail and embers streaming behind it |

### Talon of the Silent Grove — verde bosque, cuero, oro pálido, brillo verde menta

| Fichero | Habilidad | Descripción |
| --- | --- | --- |
| `icon_talon_q.png` | Flecha perforante | a single arrow seen from the side driving clean through three thin silhouetted targets in a straight line, pale gold shaft, mint green trail |
| `icon_talon_w.png` | Trampa de red | a weighted net caught mid-snap, knotted cord spread open with small weights at four corners, leather brown cord and mint green glow at the knots |
| `icon_talon_e.png` | Paso del viento | a sharp forward-leaning chevron of motion, three mint green afterimages trailing behind it, nothing else |
| `icon_talon_r.png` | Lluvia de flechas | five arrows falling steeply in parallel into a small flattened ellipse of ground, pale gold on forest green |

### Vesper of the First Light — blanco hueso, marrón cálido, oro, brillo crema

| Fichero | Habilidad | Descripción |
| --- | --- | --- |
| `icon_vesper_q.png` | Luz punzante | a narrow lance of warm light driving forward and splitting at its tip, one half continuing ahead and one half curving back as a soft returning ribbon |
| `icon_vesper_w.png` | Círculo de auxilio | a consecrated ring lying flat on the ground with warm cream light rising from its whole perimeter like a low wall of glow |
| `icon_vesper_e.png` | Égida del alba | a rounded shield of overlapping light feathers closing protectively around a small central silhouette, gold rim |
| `icon_vesper_r.png` | Alba | a sunrise breaking over a straight horizon line, rays fanning out wide and low, radiant gold and cream |

---

## 3. Iconos de objeto de tienda — `256 × 256`

Misma plantilla y mismas reglas que los de habilidad. Hoy los 24 objetos toman
prestado el icono de alguna habilidad, así que **cada uno necesita el suyo**.

### Pertrechos — T1 (oro)

| Fichero | Objeto | Descripción |
| --- | --- | --- |
| `icon_item_whetstone.png` | Piedra de amolar | a rectangular whetstone with a blade drawn across it at an angle, two or three sparks leaping off the edge |
| `icon_item_hunter_gloves.png` | Guantes del cazador | a pair of worn leather archer's bracers with laced cord, one slightly behind the other |
| `icon_item_iron_plate.png` | Placa de hierro | a riveted iron breastplate seen head-on, heavy rolled edges, dark steel |
| `icon_item_rune_focus.png` | Foco rúnico | a faceted crystal held in a four-pronged metal claw, violet light inside |
| `icon_item_swift_boots.png` | Botas veloces | a tall leather boot in profile with three short motion lines behind the heel |

### Pertrechos — T2 (oro)

| Fichero | Objeto | Descripción |
| --- | --- | --- |
| `icon_item_duelist_edge.png` | Filo del duelista | a slender duelling blade crossed over a short parrying dagger, pale steel with a gold guard |
| `icon_item_lifedrinker.png` | Bebedor de vida | a squat chalice with fangs along its rim and a single dark red drop falling into it |
| `icon_item_warding_sigil.png` | Sigilo de guarda | a hexagonal ward sigil of layered engraved rings, cold pale blue rim light |

### Pertrechos — T3 (oro)

| Fichero | Objeto | Descripción |
| --- | --- | --- |
| `icon_item_crown_of_hours.png` | Corona de las horas | a heavy crown whose points are clock hands of different lengths, muted gold |
| `icon_item_titans_heart.png` | Corazón de titán | a massive stone heart bound in iron bands, warm orange light glowing out of the cracks |

### Pociones

Tres de vida y tres de maná, en tres tamaños. **La progresión tiene que leerse
de un vistazo**: el frasco crece y gana herrajes, el color no cambia dentro de
cada familia.

| Fichero | Objeto | Descripción |
| --- | --- | --- |
| `icon_potion_health_minor.png` | Poción de vida menor | a small round glass flask with a cork, filled with deep red liquid |
| `icon_potion_health_greater.png` | Poción de vida mayor | a taller shouldered glass flask with a brass collar, filled with deep red liquid |
| `icon_potion_health_supreme.png` | Poción de vida suprema | a large faceted glass flask in a brass cage with an ornate stopper, filled with deep red liquid |
| `icon_potion_mana_minor.png` | Poción de maná menor | a small round glass flask with a cork, filled with cold blue liquid |
| `icon_potion_mana_greater.png` | Poción de maná mayor | a taller shouldered glass flask with a silver collar, filled with cold blue liquid |
| `icon_potion_mana_superior.png` | Poción de maná superior | a large faceted glass flask in a silver cage with an ornate stopper, filled with cold blue liquid |

### Tratados

Los cuatro comparten formato a propósito: son la misma categoría y deben
reconocerse como grupo. Lo que cambia es el símbolo sobre la página.

| Fichero | Objeto | Descripción |
| --- | --- | --- |
| `icon_book_power.png` | Tratado de poder | an open book seen from above, a rising sword symbol glowing on the page |
| `icon_book_vitality.png` | Tratado de vitalidad | an open book seen from above, a heart symbol glowing on the page |
| `icon_book_focus.png` | Tratado de concentración | an open book seen from above, an eye symbol glowing on the page |
| `icon_book_experience.png` | Tomo de experiencia | a thick closed tome with a metal clasp and a four-pointed star set into the cover |

### Sabotaje — T2 (influencia)

Estos cuatro **no van en dorado**: la cámara del sabotaje se tiñe de violeta en
la interfaz (`#c79ae8`). Que la paleta los separe de un vistazo del resto de la
tienda es parte de su función.

| Fichero | Objeto | Descripción |
| --- | --- | --- |
| `icon_sab_reinforcements.png` | Refuerzos | a curved war-horn with three small marching silhouettes emerging from its mouth, violet |
| `icon_sab_frenzy.png` | Frenesí | a spiked collar trailing a lash, three hard motion chevrons behind it, violet |
| `icon_sab_elite.png` | Invocar élite | a hunched creep silhouette wearing a small jagged crown, outlined by a thick violet aura |
| `icon_sab_hex.png` | Maleficio | a cracked skull sigil with a downward-pointing violet arrow driven through it |

---

## 4. Rótulos de tienda — `1024 × 256`

Dos, uno por tienda. Van de cabecera del panel, que mide 34 rem (unos 544 px),
así que la proporción 4:1 reduce limpio.

**Estos no llevan alfa**: son una franja opaca. La composición debe concentrarse
en el centro y **apagarse hacia los dos extremos**, para que funda con el panel
sin un corte duro. Sin texto: el título lo escribe la interfaz encima.

```
[PREÁMBULO DE ARTE]
Wide horizontal banner strip, 4:1. Opaque, no transparency. Composition centred
and fading to darkness at both the left and right edges. No text, no lettering,
no logos. Shallow depth, read as a backdrop and not as a scene to look into.
Subject: <DESCRIPCIÓN>
```

| Fichero | Tienda | Descripción |
| --- | --- | --- |
| `shop_banner_hero.png` | T1 · Pertrechos del héroe | an armourer's counter seen head-on: racked blades and shields behind, a breastplate on a stand, warm forge light glowing from the left, brass and gold trim, dark timber |
| `shop_banner_sabotage.png` | T2 · Cámara del sabotaje | a dark vaulted undercroft: a low brazier of violet flame at the centre, hanging chains, a table of stoppered vials and foul reagents, cold violet rim light on wet stone |

---

## Entrega de los iconos y rótulos (secciones 2, 3 y 4)

Todo esto en `public/icons/`, con el nombre exacto de la tabla. Los nombres los
uso tal cual para cablearlos, así que si cambias uno, dímelo.

Si generarlos de uno en uno sale caro, se pueden pedir en rejilla **2×2 a
1024 × 1024** agrupando los cuatro de un mismo héroe o familia: salen con el
mismo estilo entre ellos, que es justo lo que se quiere dentro de un grupo, y yo
los troceo al integrarlos. El riesgo es que el modelo no respete la rejilla; si
sale torcida, se repite esa tanda suelta.

---

## 5. Hojas de referencia de personaje — `1024 × 1024`

**El asset de mayor valor a medio plazo.** No se importan al juego: las uso para
parametrizar el constructor procedural de personajes.

Formato **obligatorio**: tres vistas ortográficas del cuerpo completo en una sola
imagen — **frontal, lateral y trasera**, alineadas a la misma altura y a la misma
escala, en pose T o A, sobre fondo transparente. Sin perspectiva.

Plantilla:
```
[PREÁMBULO DE ARTE]
Character reference sheet: three orthographic full-body views side by side —
front, side, back — same height, same scale, aligned on a shared baseline.
A-pose. Flat orthographic projection, no perspective, no foreshortening.
Transparent background, no ground shadow.
Subject: <DESCRIPCIÓN>
```

Personajes, con la silueta que ya define nuestro catálogo (`src/units/catalog.ts`).
**Respetar la silueta**: es lo que hace que se distingan de un vistazo.

| Fichero | Descripción |
| --- | --- |
| `ref_bulwark.png` | wide trapezoid armoured guardian, slab shield on the left arm, heavy war-hammer in the right, oversized pauldrons, visored helm |
| `ref_oracle.png` | tall narrow robed seer, wide fanned collar, tall staff topped with a large open ring, trailing layered robes |
| `ref_cleaver.png` | lopsided brute, one huge right pauldron and one bare shoulder, a long low-hung cleaver, hunched forward |
| `ref_spinebolt.png` | narrow vertical archer creature, wide horizontal bow held across the body, a fan of bone spines along the back |
| `ref_duskrunner.png` | low horizontal arrow-shaped runner, digitigrade legs, long counterbalancing tail, lean and fast |
| `ref_bastion.png` | squat armoured dome with no visible neck, oversized fists dragging near the ground, immovable |
| `ref_hexwright.png` | floating cluster of jagged spikes and cloth, nothing touching the ground, no legs |
| `ref_marrow_titan.png` | colossal asymmetric bone giant, one arm fused into a massive maul, crown of horns, top-heavy |

---

## 6. Texturas de material — `1024 × 1024` (opcional)

Solo si te resulta cómodo. Condiciones **estrictas**, y si no se cumplen no sirven:

- **Perfectamente tileables** (sin costura al repetir en horizontal y vertical).
- **Sin iluminación horneada**: nada de sombras, brillos ni oclusión pintada.
  Solo color base plano.
- **Sin fondo transparente** — aquí sí queremos la imagen completa.

```
Seamless tileable texture, 1024x1024, flat even lighting with NO baked shadows,
NO highlights and NO ambient occlusion — albedo colour only. Top-down orthographic.
Must tile perfectly on all four edges. Mid-saturation, hand-painted stylised
fantasy game texture.
Subject: <grass tufts / cracked dry earth / worn stone path / layered slate cliff>
```

---

## Cómo entregármelos

1. Manda los PNG tal cual, adjuntos.
2. Nómbralos **exactamente** como la tabla (`portrait_bulwark.png`, etc.). El
   nombre es lo que me dice dónde va cada uno.
3. Si un asset sale en varias variantes, añade sufijo `_v2`, `_v3` y dime cuál
   prefieres — o mándame todas y elijo yo por legibilidad a distancia de juego.

Yo me encargo de recortarlos, meterlos en `public/assets/`, cablearlos y
verificar que se ven bien en el juego.

**Prioridad si vas a generar por tandas:**
1. Los 3 retratos → impacto visual inmediato en HUD y selección de héroe.
2. Los 8 iconos → la barra de habilidades deja de ser SVG plano.
3. Las 8 hojas de referencia → dirigen el rehacer de las mallas 3D.
4. Las texturas → solo si las anteriores están hechas.

---

## Piezas rígidas de personaje (imagen → TRELLIS.2 → `.glb`)

### Por qué esto sí funciona cuando un personaje entero no

Una malla generada no se puede pegar a nuestro esqueleto: viene en su propia
pose de reposo, con sus propias longitudes de miembro, y al aplicarle nuestras
matrices de bind se desploma sobre los huesos. Por eso `MODEL_MANIFEST` sigue
vacío.

Pero eso **solo afecta a la geometría que tiene que deformarse**. Una cabeza
aquí no se deforma, porque no hay animación facial. Ni un casco, ni unos
cuernos, ni un arma, ni un ala mantenida rígida. Esas piezas se ligan con peso
1.0 a un solo hueso y lo siguen exactamente igual que una pieza procedural.

El sistema está en `src/units/build/parts.ts`. Una pieza que no existe hace que
la receta conserve la suya procedural, así que las cabezas pueden ir llegando de
una en una.

### Lo que la pieza tiene que cumplir

- **`.glb`**, Y arriba, −Z al frente.
- **Origen en la articulación de la que cuelga**, no en el centro de la malla.
  El origen de una cabeza va en la base del cuello. Si el exportador la centra
  en su caja, se corrige con `centre: true` en el manifiesto.
- **Presupuesto de triángulos: unos 500 por cabeza.** Los creeps se hornean a
  VAT y el horneado guarda cada vértice en cada fotograma, así que una pieza
  cuesta memoria por fotograma aunque sea rígida. Y en pantalla la cabeza mide
  15 píxeles: más detalle no se ve, solo se paga.

### La imagen de partida

TRELLIS reconstruye volumen a partir de una vista. Para una cabeza:

- **Vista de tres cuartos**, ni de frente plano ni de perfil. De frente pierde
  el hocico y el volumen del cráneo; de perfil pierde la simetría.
- **Fondo transparente**, sin plano de suelo ni sombra proyectada.
- **Sin cuello largo**: que la imagen termine justo donde empieza el cuello, o
  la malla traerá un tubo que hay que recortar.
- **Nada de luz dramática**: nuestro sol viene de donde viene y una sombra
  pintada encima canta.

### Prompts, uno por criatura

Todos llevan delante el **preámbulo de arte** de este documento, sin excepción.
Es lo que hace que la pieza case con la fuente y las tiendas en vez de parecer
de otro juego.

#### `head_orc.png`
```
[PREÁMBULO DE ARTE]
Head and upper neck only, 3/4 view. A brutish orc head: heavy square jaw with
two thick tusks sweeping up and OUTWARD past the cheeks so they break the
outline, a low sloping brow ridge shadowing deep-set small eyes, a short flat
snout, pointed ears swept back. Coarse weathered skin with visible pore and
scar structure. Palette: desaturated olive green, darker moss in the creases,
bone-yellow tusks.
```

#### `head_goblin.png`
```
[PREÁMBULO DE ARTE]
Head and upper neck only, 3/4 view. A small cunning goblin head: enormous
pointed ears held out sideways, far wider than the skull itself, a long hooked
nose, a wide thin mouth with small crooked teeth, big round eyes. Skull
noticeably small relative to the ears. Palette: sallow yellow-green, ruddy
nose and ear tips, dark amber eyes.
```

#### `head_ogre.png`
```
[PREÁMBULO DE ARTE]
Head and upper neck only, 3/4 view. A dull heavy ogre head: tiny eyes set far
apart under a bulging forehead, a broad flat nose, a slack heavy underbite with
two blunt lower tusks, thick rolls of fat at the neck. The head must read as
TOO SMALL for a huge body. Palette: greyish pink-brown, blotchy, dark warty
patches.
```

#### `head_wolf.png`
```
[PREÁMBULO DE ARTE]
Head and upper neck only, 3/4 view. A dire wolf head: long tapering muzzle,
bared fangs, erect pointed ears, a thick ruff of coarse fur flaring behind the
jaw and breaking the outline. Shaggy layered fur with visible clumps. Palette:
ash grey with darker guard hairs, pale muzzle, cold amber eyes.
```

#### `head_sorcerer.png`
```
[PREÁMBULO DE ARTE]
Head, hat and upper neck only, 3/4 view. A gaunt sorcerer under a tall
wide-brimmed pointed hat whose tip bends forward. Face mostly lost in the shadow
of the brim, only a sharp chin and a thin mouth visible. Hat is the dominant
mass, taller than the head beneath it. Palette: deep plum and charcoal hat,
pale grey skin.
```

#### `head_dragon.png`
```
[PREÁMBULO DE ARTE]
Head and upper neck only, 3/4 view. A reptilian dragon head: long armoured
snout, a crown of backswept horns of uneven length, a jagged frill behind the
jaw, heavy brow plates over slit eyes, exposed teeth along the jaw line.
Overlapping hard scales with chipped edges. Palette: dark oxblood red, black
horns, dull bone teeth.
```

### El patrón completo de un personaje

Una cabeza sola no arregla un personaje. El orco quedó con una cabeza esculpida
sobre un cuerpo de cajas, y el contraste lo empeoraba. El reparto que funciona:

| Pieza | Hueso | Por qué puede ser rígida |
| --- | --- | --- |
| Cabeza | `head` | No hay animación facial |
| Torso (con la joroba dentro) | `chest` | Lo que se deforma en este rig son las articulaciones, no las masas entre ellas. La columna flexa un poco y a 79 px eso no se ve |
| Arma | `hand.R` | Una hoja no se dobla |

**Los miembros se quedan procedurales a propósito.** A esta distancia un brazo
es una columna de seis píxeles: importa su silueta, no su superficie. Gastar
generaciones ahí no se ve.

Cada pieza tiene reserva: si el asset no existe, la receta construye la suya y
el juego sigue. Se pueden ir añadiendo de una en una.

**Trucos aprendidos generando la cabeza**, aplican a todas:

- **El formato da igual, y no se pide en el prompt.** Nano Banana entrega JPEG
  digas lo que digas, porque el contenedor lo decide la herramienta y no el
  modelo. Tampoco importa: TRELLIS quita el fondo por su cuenta, y la cabeza
  del orco salió limpia partiendo de un JPEG con el damero de transparencia
  pintado encima como píxeles. No pierdas tiempo persiguiendo un PNG con alfa.
- **Tres cuartos**, girado 30-40 grados. De frente Trellis no tiene profundidad
  y aplana; de perfil pierde la simetría.
- **Recorta pegado a la pieza.** Lo que sobre en la imagen sale como cáscara
  hueca en la malla.
- Lo que no se ve en la imagen se lo inventa, y lo inventa liso.
- **Una sola vista, nunca una hoja de rotación.** Pedir una pieza suelta invita
  al modelo a devolver cuatro vistas en fila, que es lo correcto para una hoja
  de referencia humana y lo peor posible para TRELLIS: reconstruye un objeto a
  partir de una vista, y con cuatro las funde en una masa. Decirlo explícito en
  el prompt («a single view, NOT a turnaround sheet, only one object in the
  image»). Si ya ha salido así, se recorta una vista y se usa esa, aunque
  entonces esa vista lleva solo un cuarto de la resolución del fichero.

### `torso_orc.png`
```
[PREÁMBULO DE ARTE]
Torso only, 3/4 view. No head, no forearms: the neck ends in a stump and the
arms are cut at the shoulder. A hulking orc's upper body: a heavy slab of
shoulder muscle piled BEHIND the neck so the back is humped, a barrel chest,
a thick gut, leather straps crossing the chest and a wide studded belt. One
shoulder carries a crude iron pauldron of riveted plates, the other is bare
green skin with old scars. Palette: desaturated olive green skin, dark brown
leather, pitted dark iron.
```

### Armas (mismo camino, mismo presupuesto)

```
[PREÁMBULO DE ARTE]
Single weapon, side view, no hands and no character. <A crude heavy orc cleaver,
a slab of chipped iron lashed to a bone handle / A gnarled wooden staff topped
with a crooked iron claw / A tree-trunk club studded with rusted spikes>.
Weapon fills the frame corner to corner. Palette: pitted dark iron, worn leather
binding, pale bone.
```

### Cómo entregármelas

El `.glb` que salga de TRELLIS, tal cual, con el nombre de la tabla. Yo me
encargo de diezmarlo al presupuesto, anotar la licencia en
`public/models/LICENSES.md`, añadir la fila al manifiesto y verificar que la
pieza se lee a 79 píxeles antes de darla por buena.
