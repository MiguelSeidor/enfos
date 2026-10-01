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

Plantilla:
```
[PREÁMBULO DE ARTE]
Single centred ability icon on transparent background. Bold simple symbol,
readable when scaled down to 40 pixels. No frame, no border, no text.
Subject: <DESCRIPCIÓN>
```

Sustituir `<DESCRIPCIÓN>` por, uno por icono:

| Fichero | Descripción |
| --- | --- |
| `icon_shield_bash.png` | a heavy round shield struck head-on, radiating impact cracks, warm amber sparks |
| `icon_anchor_shout.png` | a stylised open-mouthed roar as concentric sound arcs pushing outward, gold |
| `icon_bulwark_wall.png` | interlocking stone blocks forming a defensive barrier, cool grey with a faint blue rim |
| `icon_unbroken.png` | a sunburst breaking over a shield boss, radiant gold and white |
| `icon_arcane_bolt.png` | a sharp violet arrow of arcane energy in flight, trailing sparks |
| `icon_frost_chain.png` | jagged ice shards linked in a chain, pale cyan |
| `icon_threshold_ward.png` | a protective bubble of layered runic rings, soft teal |
| `icon_arcane_judgement.png` | a cataclysmic violet vortex seen from above, spiralling inward |

---

## 3. Hojas de referencia de personaje — `1024 × 1024`

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

## 4. Texturas de material — `1024 × 1024` (opcional)

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
