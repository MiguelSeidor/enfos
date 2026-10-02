# Convertir un pack FBX en un creep del juego

Procedimiento para meter una criatura comprada o descargada. Está escrito
después de hacerlo mal muchas veces con el orco; cada trampa de la lista costó
horas y aparece aquí con el síntoma por el que se reconoce.

Herramienta: `tools/fbx-to-creep.mjs`.

---

## 1. Qué tiene que traer el pack

| Pieza | Qué se espera |
| --- | --- |
| Malla base | Un FBX con la geometría **y el esqueleto**, en pose de bind |
| Animaciones | Un FBX por clip, con los **mismos nombres de hueso** que la malla |
| Texturas | Al menos el albedo de cada material |

Si los nombres de hueso no coinciden entre la malla y las animaciones, hay que
retargetear y eso es otro trabajo. Comprobarlo **antes** de empezar.

## 2. Preparar el material

```bash
mkdir -p public/_src/anim public/_src/tex
unzip -j 'Base+mesh+FBX.zip' '*Base mesh.fbx' -d public/_src
mv 'public/_src/Base mesh.fbx' public/_src/base.fbx
unzip -j 'animation+fbx.zip' '*.fbx' -d public/_src/anim
unzip -j texture.zip '*_Albedo.tga' -d public/_src/tex
```

`public/_src` es temporal y **no se commitea**: son cientos de megas y `public/`
se sirve al navegador. Borrarlo al terminar.

## 3. Elegir los clips mirándolos, no por el nombre del fichero

**No fiarse del nombre.** En el pack del orco, `ork@atack1.fbx` no contiene
ningún ataque: abre los brazos en cruz durante dos segundos y se queda así los
siete restantes. Elegirlo porque se llama "atack1" dio un orco que abría los
brazos y nada más.

Antes de decidir, generar una tira de fotogramas de cada candidato y mirarla.
El script de muestra está en el historial de esta sesión; lo esencial es
renderizar ~10 poses repartidas por la duración del clip, con **un solo
contexto WebGL** (crear un `WebGLRenderer` por celda agota el límite del
navegador y deja las primeras en blanco, sin aviso).

Al elegir, pensar en la cámara: el juego mira el campo **desde arriba**, así que
un mandoble horizontal se lee y un hachazo vertical se escorza hasta
desaparecer.

Luego mapear en `CLIP_SOURCES` dentro de la herramienta, con su modo de recorte:

| Modo | Para qué | Qué hace |
| --- | --- | --- |
| `loop` | idle, walk, run | Quita el relleno en pose de bind, conserva el ciclo |
| `burst` | attack, cast, hit | Aísla **una** ráfaga alrededor del pico de movimiento |
| `span` | death | Del primer movimiento al último: el cuerpo cae y se queda |

Los ficheros suelen venir rellenos hasta una duración fija y con **varios golpes
encadenados** en el mismo clip. Sin recorte, el bicho se queda quieto siete
segundos de cada nueve.

## 4. Ejecutar

```bash
node tools/fbx-to-creep.mjs
```

Luego dar de alta la criatura en `AUTHORED_MANIFEST`
(`src/units/build/authoredCharacter.ts`) con su altura en metros.

## 5. Verificación obligatoria antes de commitear

Nada de esto es opcional. Cada punto existe porque su ausencia dejó pasar un
fallo que llegó al juego.

1. **Renderizar el FBX de origen y el GLB resultante uno al lado del otro.** Si
   la silueta no coincide, la conversión ha perdido o ha movido algo.
2. **Contar los vértices de cada arma contra el esqueleto FINAL**, no contra la
   numeración previa a la reducción de huesos. Una comprobación contra índices
   viejos da cero con el fichero correcto, y al revés.
3. **No medir "vértices pesados al hueso de la mano"** para saber si un arma
   está empuñada: eso incluye los dedos del personaje y siempre da un número
   pequeño. Aislar la isla del arma por componentes conexas.
4. **Mirar las imágenes.** Si en la captura hay un hueco entre la mano y el
   arma, hay un hueco, por mucho que un número diga lo contrario.
5. **Arrancar una partida real** desde el menú y mirar la criatura en el campo.
6. **El movimiento solo lo puede juzgar una persona.** El arnés headless no
   mueve el bucle de render: entre capturas los huesos están congelados, así que
   cualquier medición de animación tomada por ahí no vale. Ver
   `qa/REVIEW_RUBRIC.md` para el listón visual.

## 6. Trampas conocidas, con su síntoma

| Síntoma en el juego | Causa |
| --- | --- |
| Un arma flotando al lado del cuerpo | **Varios esqueletos en el FBX** (el orco traía 49, uno por submalla, con los mismos huesos en distinto orden). Los índices de piel de cada submalla indexan *su* array. Hay que construir un esqueleto único **por nombre de hueso** y reescribir todos los índices. Es el fallo que más caro salió |
| El bicho no se dibuja, sin error ni aviso | Geometría **sin grupos de dibujo** con un material en array. three recorre los grupos; cero grupos, cero llamadas |
| El bicho no se dibuja, con la textura VAT | Más de **16.384 vértices**: el límite de anchura de textura. WebGL lo rechaza en silencio |
| El bicho mide dos centímetros | Escala de raíz aplicada dos veces. `boneInverses` ya la lleva dentro |
| Se desliza sin mover las piernas | El clip lleva **movimiento de raíz** horneado, o se está reproduciendo `walk` a una velocidad para la que no fue animado. Un ciclo de andar cubre terreno real: el del orco está hecho para 0,64 m/s y el creep se mueve a 3,47 |
| Parpadea al atacar | Un `crossFade` de una acción **consigo misma**: programa fundido de salida y de entrada sobre el mismo peso y lo deja en cero |
| Tirones con pocas criaturas | Jerarquía inflada. El FBX deja **una cadena de nodos vacíos delante de cada hueso**; el orco llegaba con 5.684 nodos para 139 huesos |
| Texturas descolocadas al unir materiales | El exportador escribe cada grupo de dibujo como una malla glTF propia **con copia entera del buffer de vértices**. Mejor un atlas y un solo material |

## 7. Presupuesto

Medido con el orco, a 1600x900 con sombras, sincronizando con la GPU:

| Criaturas | ms por fotograma |
| --- | --- |
| 10 | 1,5 |
| 30 | 4,7 |
| 50 | 9,7 |
| 80 | 17,6 |

El presupuesto de 60 fps es 16,6 ms **para todo el juego**. Objetivo por
criatura tras convertir: **~3.500 triángulos, ~55 huesos, ~120 nodos, un solo
material**. El orco pasó de 20,2 ms a 4,7 ms con 30 en pantalla recortando el
esqueleto de 139 huesos a 55 y la jerarquía de 5.596 nodos a 121.

Un rig de cine trae articulaciones para cada dedo, cada cuchillo del cinturón y
cada fleco del faldón. A 79 píxeles de altura no se ve ninguna, pero se paga
entera.

## 8. Licencias

Anotar el asset en `public/models/LICENSES.md` **antes** de usarlo. Gratuito no
implica libre: la licencia Royalty Free de CGTrader permite uso comercial en
videojuegos pero exige que un tercero no pueda extraer el modelo, y un juego de
navegador sirve sus assets al cliente. El orco sigue pendiente de resolver eso.
