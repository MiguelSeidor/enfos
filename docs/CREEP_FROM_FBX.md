# Convertir un pack FBX en un creep del juego

Procedimiento para meter una criatura comprada o descargada. Está escrito
después de hacerlo mal muchas veces con el orco; cada trampa de la lista costó
horas y aparece aquí con el síntoma por el que se reconoce.

Herramienta: `tools/fbx-to-creep.mjs`.

---

## 0. Las dos reglas que están por encima del resto

Las dos salieron de lo mismo: decidir en vez de comprobar. Ninguna de las
trampas técnicas de este documento habría costado lo que costó si se hubieran
respetado.

### Hacer caso a lo que dice el dueño del proyecto

Lo que él ve en el juego es el dato bueno. Si su descripción choca con mi
lectura de una captura, **el que se equivoca soy yo** hasta que tenga una
medición que demuestre otra cosa.

Dijo dos veces que el orco llevaba dos hachas, una en cada mano. Las dos veces
decidí, mirando un render gris de baja resolución, que eran garras del brazo.
Sobre esa conclusión se construyeron cinco "arreglos" seguidos que movieron
piezas sanas, borraron un arma y dejaron el personaje peor que al principio.
El FBX de origen, abierto al fin, mostraba las dos hachas empuñadas.

Discrepar está bien cuando hay evidencia. Decidir en silencio y seguir
construyendo encima, no.

### Mirar lo que hay de verdad en los ficheros antes de inventar

Abrir el fichero y mirarlo. No deducir su contenido del nombre, de lo que suele
traer un pack, ni de lo que tendría sentido que trajera.

- El pack traía la respuesta a todo desde el primer día, en tres zips que el
  dueño ya había descargado y había dicho que usara. Se tardó una semana en
  abrirlos.
- `ork@atack1.fbx` no contiene ningún ataque. El nombre decía que sí.
- La malla base tenía **49 esqueletos**, cosa que nadie supondría y que
  explicaba por sí sola meses de síntomas raros.
- Las hachas venían atadas limpiamente a `ork_right_axe_1` y `ork_left_axe_1`.
  No había que colocarlas: había que dejar de romperlas.

Corolario: una medición que **no puede fallar** no es una verificación. Medir
"vértices pesados al hueso de la mano" para saber si un arma está empuñada
incluye los dedos del personaje y siempre dará un número pequeño, con el arma
en el puño o al otro lado del mapa.

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

Al elegir, pensar en la cámara y en el **tiempo**, que importa igual o más:

- El juego mira el campo desde arriba, así que un movimiento que recorre el
  plano del suelo se lee y uno que va de frente se escorza.
- Un giro de torso de dos décimas de segundo no se aprecia a esta distancia.
  Entre dos clips, gana el que reparte el movimiento en fases largas, aunque
  tenga menos energía total. El `atack3` del orco tenía el doble de movimiento
  que el `atack2` y se veía peor, porque lo gastaba todo en 0,2 s.
- El clip no debe durar más que el hueco entre ataques (`1 / attackSpeed`), o su
  final no lo ve nadie. Para el cleaver son 1,18 s. `maxSeconds` recorta la cola
  de recuperación para que quepa.

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
6. **Medir el giro del clip ya exportado**, no el del FBX de origen. Son dos
   cosas distintas y la conversión puede perderlo entero. Dos métricas
   independientes que no degeneran: el eje derecho de las caderas proyectado al
   suelo, y el ángulo de la mano (o del arma) orbitando alrededor de las
   caderas. **No usar la línea de hombros**: con los brazos abiertos su
   proyección al suelo se acerca a cero y el ángulo acumula vueltas que no
   existen. El conversor imprime `structuralBones`; si sale vacío en un
   humanoide, se ha descartado la raíz y el bicho no girará.
7. **El movimiento solo lo puede juzgar una persona.** El arnés headless no
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
| El ataque **se insinúa y desaparece** | No es el modelo. `movement.ts` reafirma el clip de locomoción en **cada tick de simulación** y `playAnimation` fuerza el cambio, así que el ataque que lanza el combate lo sustituye `run` 33 ms después. Estuvo oculto mucho tiempo porque el animador procedural de los héroes ignora la re-reproducción de un bucle que ya está corriendo, así que el pisotón solo se notaba en clips de un disparo. La locomoción no debe interrumpir una acción sin terminar |
| Mueve los miembros pero **no gira el cuerpo** | Se ha descartado un hueso **estructural**. En este rig `ork_Hips` no mueve ni un vértice (la pelvis está pesada a la columna y a los muslos) pero es la raíz de la que cuelga todo, y el ataque entero es una rotación suya de 360°. Una regla de "conservar huesos con N vértices o más" lo tira. Hay que conservar además **todo ascendiente de un hueso conservado**, aunque no mueva nada |
| Se pierden ascendientes al podar el esqueleto | Recorrer la jerarquía **por identidad de objeto** falla: con varios esqueletos el mismo hueso llega como instancias distintas, y entre hueso y hueso hay cuarenta envoltorios. Recorrer **por nombre** y no detenerse en el primer nodo que no sea hueso |

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
