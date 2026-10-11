# Lecciones de meter a Bulwark

Bulwark pasó de un retrato pintado a un héroe jugable con martillo y escudo.
Tardó dos días. **Casi nada de ese tiempo fue el personaje**: fue colocar un
arma de 900 triángulos en una mano, y la mayoría de los errores los cometí dos
y tres veces.

Este documento existe para que Talon tarde una tarde. Está ordenado por **lo
que costó cada cosa**, no por temas, porque lo que más tiempo robó no fue lo
más difícil sino lo más fácil de dar por supuesto.

El camino en sí —Rodin, AccuRIG, ActorCore, el conversor— está en
[`HERO_FROM_IMAGE.md`](HERO_FROM_IMAGE.md). Esto es lo que ese documento no
cuenta.

---

## El orden correcto

Hacerlo en este orden evita la mayoría de lo que viene después.

1. **Elegir los siete movimientos del MISMO set armado, antes de tocar nada
   más.** Esto es lo primero por una razón: con un set mezclado no hay
   colocación de arma que funcione, y no se descubre hasta el final.
2. Generar la malla en Rodin **con las manos vacías**, en pose T.
3. Riggear en AccuRIG. Paso 3 con `Front Part`, revisando la profundidad en
   vista lateral. Paso 5 `Calibrate` si el hombro atraviesa el torso.
4. Descargar los siete movimientos apuntando a ese actor.
5. Convertir. Mirar el recorte de cada clip en la salida del conversor.
6. Generar el arma aparte en Rodin, pasarla por `tools/prop-to-glb.mjs`.
7. Colocarla: anclar al **puño**, orientar sobre el eje de los nudillos,
   comprobar **en partida**.

---

## Las trampas, por lo que costaron

### 1. Un set de movimientos mezclado no tiene solución

**Lo que pasó:** el ataque venía de un set de espada y escudo; el reposo, el
andar y el correr eran movimientos de mano neutra. Una sola empuñadura no
puede servir a una mano posada alrededor de un arma y a tres posadas alrededor
de nada. Perdí un día entero ajustando ángulos contra una contradicción.

**La regla:** los siete clips salen del mismo set. Si uno no existe en ese set,
se busca el más parecido **dentro de él** antes que el perfecto fuera.

**De paso:** los clips armados **cierran los dedos ellos solos** —0,776 de
razón punta-nudillo, frente a 0,96 de los desarmados—. No hace falta cerrar el
puño a mano. El campo `fists` del manifiesto existe por si algún personaje
llega con las manos abiertas, pero con un set armado sobra.

### 2. `CC_Base_R_Hand` es la MUÑECA, no el puño

El puño cerrado está **16,5 unidades más allá** — un cuarto de metro a la
escala de Bulwark. Seis colocaciones seguidas clavaron el mango ahí y el arma
se leía flotando **apuntase donde apuntase**, así que cambiar el ángulo no
podía arreglarlo nunca.

**La regla:** el punto de anclaje es el centro de los segundos nudillos:

```js
const k2 = ['Index2', 'Mid2', 'Ring2', 'Pinky2'].map((n) => bone(`CC_Base_R_${n}`));
// promediados en el espacio local de la mano
```

### 3. Dirección del mango y giro de la cabeza son dos cosas distintas

«El arma está al revés» se puede referir a dos cantidades independientes: hacia
dónde apunta el palo, y cómo está girada la cabeza **alrededor** de ese palo.
Las confundí una y otra vez y giraba la primera cuando había que girar la
segunda.

**La regla:** ante «está mal orientada», preguntar cuál de las dos. O mejor,
sacar una tira con las dos variaciones y que el dueño señale.

### 4. El eje del mango se mide, no se elige

Un mango agarrado va por la línea de los nudillos. Pero los cuatro nudillos
están escalonados **a lo largo** de la mano además de a lo ancho —el del
meñique está 6,5 unidades más lejos de la muñeca que el del índice—, así que un
ajuste de recta directo recoge ese escalonamiento e inclina el eje hacia los
dedos. Quitándolo queda el **−Z local de la mano**, atravesado en la palma.

### 5. Una orientación resuelta contra una pose miente en todas las demás

Orienté el martillo como «que apunte hacia abajo en reposo». Eso dejó el mango
alineado con el antebrazo por casualidad, y en el ataque el arma prolongaba el
brazo: un palo saliendo del hombro.

**La regla:** la orientación se expresa en el espacio del hueso, nunca como una
dirección del mundo resuelta en un fotograma.

**Y el límite que hay detrás:** la muñeca solo gira entre 12° y 35° del reposo
al ataque. Un arma atornillada a la mano mantiene casi el mismo ángulo con el
antebrazo en todas las poses. No existe transformación que luzca bien en los
siete clips, y **no hace falta que exista** si todos vienen del mismo set
armado: cada uno sostiene el arma como la posó el animador.

### 6. Los clips traen el viaje entero: arranque, pasos y parada

Ni el andar ni el correr son ciclos limpios. `runforward` dura 4 s y tiene
**0,8 s de hombre parado al principio y otros 0,8 al final**. Reproducido en
bucle, eso es «unos pasos y un planeo», repetido.

Y recortar la parada no basta: hay que recortar a un **número entero de ciclos
de marcha**, entre picos del mismo pie, o el bucle reinicia a media zancada y
el salto se lee igual de mal. Mi primer recorte dejó 3,8 ciclos y no arregló
nada.

**Cómo se mide:** muestrear la altura (o el avance) de un pie a lo largo del
clip y localizar los picos del mismo pie. Dos picos consecutivos son un ciclo.

| clip | original | ventana | resultado |
| --- | --- | --- | --- |
| andar | 8,75 s | `[1.75, 7.0]` | 5,25 s, 3 ciclos |
| correr | 4 s | `[1.0, 2.5]` | 1,5 s, 2 ciclos |
| muerte | 6,28 s | `[0, 2.3]` | 2,3 s, antes de levantarse |

### 7. La ventana del recorte va en tiempo del FICHERO, no del clip recortado

Medí el momento de la caída sobre el clip ya recortado por `span` y puse la
ventana con ese número. Cayó antes de la caída. Las ventanas se miden siempre
sobre el FBX original.

### 8. El FBX fuente es Z arriba

Medí la altura de la cabeza en el eje Y y obtuve un perfil que no era una
altura. Los FBX de ActorCore son **Z arriba**; el GLB convertido es Y arriba.
Saber en cuál de los dos se está midiendo.

### 9. Las animaciones de muerte se levantan

`fall_left` cae a los 1,57 s, se queda en el suelo hasta los 2,3 y a los 4,1
está otra vez de pie. Sin recortar, el cadáver se incorpora. **Comprobar
siempre el último fotograma de la muerte.**

### 10. Un empuje de hueso aplicado cada fotograma se acumula

Para abrir el brazo del escudo hay un `boneNudges` que se aplica **después**
del mixer, porque un hueso animado se reescribe en cada fotograma y una pose
puesta al cargar no sobrevive. Pero al morir, el clip se congela y **deja de
escribir el hueso** — y el empuje se multiplicaba sobre su propio resultado,
así que el escudo giraba sin parar sobre el cadáver.

`AuthoredView` ahora guarda lo que escribió el clip y aplica el empuje siempre
sobre eso. Si se añade otro empuje, mantener esa disciplina.

### 11. El ritmo de la locomoción no está donde el código lo busca

`authoredPace` lee cuánto se desplaza el hueso raíz para saber a qué velocidad
está animado un clip. **Los clips de ActorCore no se desplazan nada** — el
recorrido de cadera de Bulwark es exactamente cero—, así que caía a una
constante de 0,64 m/s prestada de otro personaje. Con el héroe a 6,6 m/s eso
pedía un factor de 10, que se recorta al tope de 3,2: las piernas iban tres
veces más lentas de lo necesario y los pies patinaban.

Ahora, cuando no hay desplazamiento, se deduce de **la zancada y la cadencia**:
cuánto se separan los pies dividido por lo que dura un paso.

**Dos intentos fallidos por el camino:** seguir el pie plantado no sirve (estos
clips están animados en el sitio de verdad, el pie no desliza: da 0,014 m/s), y
las posiciones de hueso **ya vienen en metros** porque cuelgan del grupo
escalado — multiplicarlas otra vez por `worldScale` las divide por 64.

---

## El conversor: lo que hay que poner y por qué

Para un héroe salido de esta cadena, la entrada en `CHARACTERS` necesita:

```js
atlas: { embedded: true, size: 2048 },
budget: { model: 20000 },
weld: { byPosition: true },   // sin esto NO decima: ver abajo
upAxis: 'Z',
inPlace: true,
alsoKeepBones: '(Index|Mid|Ring|Pinky|Thumb)\\d$',
```

- **`weld: { byPosition: true }`** es el que no es evidente. Sin él el
  decimador devuelve los 500.000 triángulos intactos, con cualquier error y con
  o sin `LockBorder`: la malla llega con 1,5 M de vértices sin compartir
  ninguno, y la soldadura normal no basta porque su clave incluye la normal y
  estos personajes son placas con arista dura por todas partes.
- **`budget: 20000`** y no 7.000. A 7.000 las manos se decimaban hasta
  desaparecer y el conversor borraba los huesos de dedo por no mover ningún
  vértice.
- **`inPlace`** quita el desplazamiento horizontal de la cadera. Lo mantiene
  aunque estos clips no lleven ninguno, porque el siguiente set puede llevarlo.

### Y una trampa del propio fichero

**Erika y Bulwark tienen líneas de clip idénticas carácter por carácter.** Dos
parches míos fueron a parar a la entrada de Erika porque la primera coincidencia
gana. Al editar `CHARACTERS`, localizar primero el bloque del personaje y buscar
dentro de él. Y después de cada parche, **releer el fichero para confirmar que
el cambio está donde debía**.

---

## Los accesorios

`tools/prop-to-glb.mjs` convierte un prop de Rodin. Dos cosas:

- **Rodin entrega metalness 1,0 con su mapa.** El conversor tira el mapa, así
  que heredar el escalar deja un objeto metálico puro sin nada que reflejar —
  los dos accesorios salieron casi negros. Va forzado a 0.
- **Una superficie ancha con relieve bajo se rompe antes que un objeto
  compacto.** El escudo se abría en agujeros a 875 triángulos; el martillo
  aguanta a 700. Presupuestos: martillo 900, escudo 2.600.

Tamaños medidos contra el personaje, no contra una persona: Bulwark mide
2,62 m, que son **64,6 unidades por metro** en su propio fichero.

---

## El método, que es lo que más fallé

### Solo capturas de partida real

Durante una ronda entera enseñé renders de un script mientras el juego tenía
otra cosa, porque **un parche había quedado rechazado y nunca se escribió**. El
dueño lo detectó antes que yo. Un render de script no prueba nada sobre el
juego.

### Juzgar desde la cámara del juego

La cámara va entre **33° y 56°** sobre la horizontal (`render/camera.ts`). Un
escudo que apunta recto al frente es perfecto de perfil y una línea dorada en
el codo desde arriba. Todo render de validación se saca desde esos ángulos.

### Cuando hay que elegir una colocación, enseñar opciones

Seis rondas interpretando descripciones acabaron en sitios distintos cada vez.
Una tira de seis orientaciones etiquetadas, **generada dentro de una partida**
variando el objeto entre capturas, lo resolvió en una. Es el método por
defecto para cualquier cosa que dependa del gusto.

### No optimizar una métrica que no es el objetivo

Monté una barrida para elegir el ángulo del arma pidiendo «que no se meta en el
cuerpo». La forma de no meterse en un cuerpo es llevar el arma estirada hacia
fuera, y eso devolvió. La métrica medía bien; no era el objetivo.

### Una distancia pequeña no es un agarre

Medí 1,6 unidades entre el hueso y el escudo y dije «está en la mano». Esa
distancia solo dice que dos cosas están cerca. Y los dedos estaban abiertos —lo
había medido yo mismo y lo había escrito—. **Comprobar lo que se afirma, no lo
que se puede medir fácil.**

---

## Lo específico de Talon

Talon lleva arco y dispara. Lo que cambia:

**El arco va en la mano IZQUIERDA.** Un arquero diestro sujeta el arco con la
izquierda y tensa con la derecha. Todo lo de este documento sobre
`CC_Base_R_Hand` se aplica igual a `CC_Base_L_Hand`, con el signo del eje de
nudillos espejado — en Bulwark el eje de la izquierda salió `(-0.025, 0.67,
-0.742)` frente a `(0.025, 0.664, -0.747)` de la derecha.

**El set de movimientos es de arquería, y hay que elegirlo entero antes de
empezar.** En la categoría Combat de ActorCore hay sets de arco igual que el de
espada y escudo del que salieron los de Bulwark. Los siete del mismo.

**La flecha: no la modeles aparte.** Una flecha en vuelo es un efecto del
juego, no un accesorio del personaje. Si el set de disparo la necesita visible
en la mano durante la tensión, que forme parte de la malla del arco.

**El momento del impacto es distinto.** `SWING_IMPACT` en `combat.ts` está en
0,85 — el final del swing, que es donde un martillo golpea. **Una flecha sale
en la suelta**, que cae antes. Si Talon se siente desacompasado, ese valor
tendrá que pasar a ser por personaje en vez de global. Es la limitación
conocida más probable de que aparezca.

**El arco es largo y fino**, que es la forma que la decimación destruye primero
—está anotado para el arco de Erika en `fbx-to-creep.mjs`—. Darle presupuesto
propio y generoso, y mirar el resultado antes de montarlo.

---

## Lo que sigue sin resolver

- **El `SWING_IMPACT` es global.** Vale para un martillo; un arco y un bastón
  querrán otro.
- **Oracle y Vesper** llevan bastón y cayado: objetos largos y finos, mismo
  aviso que el arco.
- **Vesper lleva halo**, que va al hueso de la cabeza, no a una mano.
- **El color del martillo de Bulwark** salió verde azulado en vez de acero. Sin
  resolver, por si algún día se regenera.
