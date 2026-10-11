# Un héroe a partir de una imagen

Cómo convertir el retrato de un héroe en un personaje 3D riggeado y animado que
entre por `tools/fbx-to-creep.mjs`. Escrito el 2026-10-08 tras investigar las
herramientas actuales.

Esto **no** es el camino de los creeps. Un creep puede ser cualquier cosa
descargada, y por eso `docs/CREEP_FROM_FBX.md` empieza en un FBX que ya existe.
Un héroe tiene que parecerse a su retrato, y ese retrato ya existe en
`public/portraits/`. No hay un pack que comprar: hay que generarlo.

---

## Por qué fracasó el intento anterior, y qué cambia

En agosto de 2026 se validó la generación por IA de imagen a 3D y funcionó para
**estructuras estáticas**: el Núcleo, las dos tiendas y los portales se generaron
así y están en el juego. Para **personajes animados** falló, y la causa está
anotada: desajuste de pose de bind. El esqueletado automático supone que la
malla está construida en la misma pose que describen sus matrices inversas, y
cuando no coincide el personaje colapsa en una mancha. Tripo dio error y Mixamo
rechazó la malla.

Lo que cambia ahora es que el paso que falló era el **esqueletado**, y es
precisamente el paso que se puede separar y hacer con otra herramienta. En las
pruebas independientes de 2026 el mejor riggeador automático no es ninguno de
los dos que probamos: es **AccuRig**, de Reallusion, descrito como la salida más
limpia, con pesos ajustados y colocación de huesos a la altura de un rigger
experto. Es gratis y no se ha probado aquí.

---

> **Antes de empezar, lee [`HEROES_LECCIONES.md`](HEROES_LECCIONES.md).** Este
> documento cuenta el camino; aquel cuenta lo que salio mal recorriendolo con
> Bulwark, que costo dos dias y casi nada de ello fue el personaje.

## La cadena, en cuatro pasos

### 1. Imagen → malla, en pose T

**Rodin (Hyper3D)** o **Meshy**. Los dos aceptan una imagen de referencia.

Lo que importa de este paso no es el detalle, es la **pose**. Rodin permite
forzar por API que el modelo salga en pose T o A, que es exactamente lo que el
riggeador necesita y lo que evita el desajuste de bind que nos hundió antes.
Pídelo en pose T, de frente, brazos extendidos, sin apoyos ni base.

- Rodin: geometría más limpia, topología de cuadriláteros, **no riggea**. Desde
  unos 30 $/mes. La API está en el plan de 120 $/mes, pero para cuatro
  personajes no hace falta API: basta la web.
- Meshy: hace de todo en una sola herramienta, incluido el rigging, pero en las
  pruebas independientes sus pesos de cadera quedan descolocados entre 5 y 15 cm
  y los pies patinan. Sirve para salir del paso, no para un héroe.

Sal de aquí con un **OBJ o FBX en pose T**, sin esqueleto.

> **Sin armas.** La malla que entra en Rodin y en AccuRig es el héroe con las
> manos vacías: sin arma, sin escudo, sin peana. Ver «Las armas van aparte»
> más abajo.

#### La pantalla de Rodin, botón por botón

Anotado el 2026-10-09 generando a Bulwark, porque la pantalla ofrece tres
botones y solo uno lleva a donde queremos.

| botón | qué hace | aquí |
| --- | --- | --- |
| **Confirm** | congela la geometría y desbloquea Material | **es el camino** |
| **Bang to Parts** | parte el modelo en piezas sueltas | **no** |
| **Redo** | vuelve a generar con el mismo prompt y la misma imagen | solo si falla la revisión de abajo |

**Bang to Parts está pensado para props**: un cofre, un arma que quieras
desmontar. Un personaje que va a riggearse quiere lo contrario, **una sola malla
continua**. En piezas, el riggeador pesa cada trozo por su cuenta y las juntas
se abren al levantar el brazo; y en el juego es una llamada de dibujo por pieza.

**Antes de pulsar Confirm**, gira el modelo y mira dos cosas, porque después de
confirmar ya no se corrigen gratis:

- **La espalda.** Si la referencia solo enseña el frente, la espalda sale
  inventada, y a veces sale lisa o deshecha.
- **Que los brazos no toquen el torso.** Si la axila está cerrada, la malla se
  suelda ahí y el hombro no deforma. Es el fallo que hundió el intento de 2026.

Las manos importan menos. Si salen como manoplas con los dedos fundidos vale
igual: aquí no se animan dedos, y el arma va atada con peso 1,0 al hueso de la
mano. Un puño cerrado incluso ayuda a que el martillo asiente.

De los ajustes, **Symmetric conviene dejarlo puesto** — un personaje simétrico
riggea mejor — y el conmutador de pose T/A es justo el que evita el desajuste de
bind. El resto puede quedarse como viene.

#### Y en Pack, al descargar

Aquí es donde se decide si el modelo entra en el juego o hay que repetirlo:

| opción | elegir | por qué |
| --- | --- | --- |
| Geometry | **Base Model** | el High-poly es un esculpido de millones de triángulos; ni AccuRig ni un navegador lo quieren |
| formato | **.fbx** | AccuRig come OBJ y FBX, y el FBX se trae las UV y los materiales |
| Material | **PBR**, nunca Shaded | Shaded **hornea la luz dentro de la textura**, y esta escena tiene sus propias luces y su pasada de oclusión: la luz horneada pelearía con ellas. PBR entrega color, normales y rugosidad por separado, que es lo que espera `MeshStandardMaterial` |
| resolución | **2K** | 4K es cuatro veces la descarga, por cuatro héroes, en un juego de navegador |

Lo descargado va a una carpeta propia en la raíz del repositorio — `bulwark/`,
junto a `orc/`, `crusader/` y `erika/` — que es de donde lee
`tools/fbx-to-creep.mjs`.

#### Qué trae el zip, y cuál de los dos FBX

El paquete llega con siete ficheros y dos de ellos son FBX, lo que no es
evidente. Medido sobre `bulwark/Bulwark_FBX.zip` el 2026-10-09 leyendo el
binario, no deducido del nombre:

| | `base.fbx` | `base_basic_pbr.fbx` |
| --- | --- | --- |
| formato | FBX binario 7400 | FBX binario 7400 |
| mallas | 1 sola | 1 sola |
| vértices | 249.996 | 249.996 |
| triángulos | 500.000 | 500.000 |
| texturas dentro | **ninguna** | **4 PNG empotrados** |
| esqueleto | **no** | **no** |

Es la **misma malla**. Los 8,7 MB de diferencia son exactamente los cuatro PNG
— diffuse, metallic, normal y roughness — metidos dentro del fichero y
conectados por nodos `Texture` y `Video`.

**Usa `base_basic_pbr.fbx`.** Vas a colocar guías sobre un hombre cubierto de
armadura: con textura se ve dónde está la muñeca y dónde la rodilla, y sin ella
es un bulto gris. Además el conversor ya sabe leer texturas empotradas en un
FBX: es la ruta `atlas: { embedded: true }` que usa Erika.

Guarda igualmente los PNG sueltos por si el riggeador los pierde al exportar.
`texture_pbr.png` no lo referencia el FBX; es un mapa de más y se ignora.

**Ninguno de los dos trae esqueleto** — no hay nodos `Deformer` ni `Pose` —,
que es justo el motivo de que exista el paso siguiente.

**Aviso de peso: 500.000 triángulos.** La pantalla de inicio de AccuRig
recomienda por debajo de 600.000, así que entra, pero por poco. Para comparar,
el orco va por el juego con unos 3.600. El conversor decima, así que aguas
abajo no es un problema; lo que puede ir lento es AccuRig. Si se atraganta, se
decima antes en Blender.

### 2. Malla → esqueleto, con AccuRig

Gratis, de Reallusion, solo Windows. Pide una cuenta gratuita de ActorCore para
poder exportar, incluso en local.

Las direcciones, comprobadas el 2026-10-09:

| para qué | dónde |
| --- | --- |
| descargar AccuRig | <https://actorcore.reallusion.com/auto-rig/accurig>, botón **DOWNLOAD FREE** (baja `AccuRig_Webinstaller.exe`) |
| manual oficial | <https://manual.reallusion.com/actorcore-accurig-1/> |
| catálogo de movimientos | <https://actorcore.reallusion.com/3d-motion> |
| la suscripción | <https://actorcore.reallusion.com/motion-subscription> |

La cuenta no hay que crearla por separado: el instalador y la primera ejecución
la piden.

Acepta OBJ y FBX, y recomienda pose T o A, que es lo que trae el paso anterior.
Saca un esqueleto de **19 huesos de cuerpo más un rig de manos**, y exporta FBX
con preajustes por motor.

Aquí es donde se decide si el personaje sirve. Antes de seguir, **mira cómo
deforma el hombro y la cadera levantando el brazo**: es el sitio donde falla
todo riggeador automático y es lo que hundió a Tripo en las pruebas de 2026.

### 3. Esqueleto → movimiento, con ActorCore

Y este es el motivo real de elegir AccuRig: **ActorCore es del mismo
fabricante**, así que las animaciones vienen sobre el mismo esqueleto y **no hay
que hacer retargeting**. El retargeting entre esqueletos distintos es de donde
salen los pies que patinan y las piernas que se estiran, y aquí no existe.

AccuRig 2.0 trae una pestaña para examinar el catálogo de ActorCore y verlo
sobre tu propio personaje antes de comprar nada.

**El precio, comprobado en la web el 2026-10-09.** Sueltos cuestan entre 1,50 $
y 12 $. Pero hay una **suscripción de 29 $/mes por 20 movimientos** con tres
condiciones que la hacen la opción obvia aquí: los movimientos descargados son
**tuyos para siempre**, la licencia **sigue valiendo después de cancelar**, y no
hay permanencia. Las descargas no se acumulan de un mes para otro.

Y necesitas menos de los que parece. Son siete por héroe — reposo, andar,
correr, ataque, lanzar hechizo, recibir un golpe y morir — pero **AccuRig le da
el mismo esqueleto de 19 huesos a los cuatro**, así que cinco de esos siete
(reposo, andar, correr, golpe y muerte) sirven para todos. Solo ataque y
hechizo tienen que ser propios de cada héroe:

    5 compartidos + 2 x 4 héroes = 13 movimientos

Trece caben en un solo mes. **Un mes, 29 $, se cancela, y los movimientos se
quedan.**

El reparo: los cuatro comparten nombres de hueso pero no proporciones. Bulwark
es bajo y ancho y Talon es espigado, así que un mismo ciclo de andar puede
patinar en uno de los dos. Se corrige ajustando la velocidad del ciclo, que es
lo que ya hace `speed` en las entradas de `clips`.

### 4. FBX → GLB, con lo que ya tenemos

Y aquí no hay nada nuevo que construir, que es lo mejor de esta ruta.

Lo que sale del paso 3 es **exactamente la forma que el conversor ya come**: una
malla base en FBX más un FBX por animación, que es como vienen los packs del
orco y del cruzado. Se añade una entrada a `CHARACTERS` en
`tools/fbx-to-creep.mjs` y se sigue `docs/CREEP_FROM_FBX.md`, con su tabla de
síntomas y sus trampas ya documentadas.

---

## Las armas van aparte

La malla que se genera y se riggea es el héroe **con las manos vacías**. El arma
se añade después, y hay una razón a cada lado.

**Al riggear, el arma estorba.** Un riggeador automático busca una silueta
humanoide, y un bastón o un arco en pose T se salen del contorno como si fueran
un miembro más. AccuRig produce 19 huesos de cuerpo más un rig de manos y **no
crea huesos de arma**: si el arco viene pegado a la malla, repartirá sus pesos
entre los huesos del brazo y el arma se doblará al moverse.

**Al montarla después, es trivial, y eso ya lo sabemos aquí.** Lo que está
anotado de los intentos de 2026 es que las piezas rígidas atadas con peso 1,0 a
un solo hueso sí cargan bien: no se deforman porque no se interpolan. Y las
animaciones de ActorCore son de cuerpo, así que un arma colgada de la mano la
sigue sin que haya que hacer nada.

| héroe | pieza y hueso |
| --- | --- |
| Bulwark | martillo a la mano derecha, escudo al antebrazo izquierdo |
| Oracle | bastón a la mano |
| Talon | arco a la mano izquierda; la cuerda es parte de la pieza |
| Vesper | cayado a la mano, y el **halo al hueso de la cabeza** |

**La excepción:** un arma articulada no sale de aquí. El mayal del cruzado tiene
bola, doce eslabones y mango, cada uno con su hueso, y eso venía riggeado a mano
por el autor del pack. Si un héroe necesitase algo así, los huesos habría que
ponerlos a mano en Blender después de AccuRig. Para un arco, un martillo o un
bastón no hace falta: son rígidos.

---

## Antes de pagar por cuatro

**Haz uno entero primero.** El paso que puede fallar es el 2, y no se sabe si
falla hasta que se ve el hombro deformar. Gastar en movimientos para cuatro
héroes antes de saber si el riggeado aguanta es gastar cuatro veces el mismo
riesgo.

Orden sugerido: **Bulwark**. Va cubierto de armadura, así que una deformación
imperfecta del hombro se nota menos que en Talon, que lleva un brazo desnudo.
Si Bulwark pasa, el resto es repetir.

## Licencias

La regla del proyecto no cambia: un asset sin licencia anotada en
`public/models/LICENSES.md` no se usa.

Reallusion cambió su EULA el 1 de agosto de 2025: desapareció la Licencia
Extendida y la Estándar pasó a cubrir el uso en juegos. Su página de política
dice que la Estándar permite distribuir los assets en juegos y proyectos XR a
escala. Hay que **leerlo antes de comprar**, no después, y anotar la referencia
en la tabla.

Dos restricciones a comprobar expresamente para este proyecto: no se puede
sublicenciar ni entregar el contenido a terceros, y la creación de personajes
dentro del juego requiere una licencia Enterprise negociada aparte. Lo primero
importa porque un juego de navegador sirve sus assets al cliente, que es el
mismo problema que tiene pendiente el orco con CGTrader.

---

## Fuentes

- [AI Auto-Rigging Showdown 2026: Tripo, Meshy, Cascadeur, AccuRig y Mixamo](https://www.strayspark.studio/blog/ai-auto-rigging-showdown-2026-tripo-meshy-cascadeur-mixamo)
- [Best AI for 3D Models 2026: Meshy vs Tripo vs Rodin](https://coruzant.com/ai/best-ai-for-3d-models-honest-comparison/)
- [Tripo 3.1 Review: Fast 3D, But Is the Geometry Usable?](https://blog.neural4d.com/comparisons/tripo-3-1-model-review/)
- [Reallusion lanza AccuRig, gratuito](https://80.lv/articles/reallusion-released-free-automatic-rigging-tool-accurig/)
- [AccuRig 1.3 y el rig de 19 huesos](https://www.cgchannel.com/2023/10/rig-and-showcase-3d-characters-for-free-with-accurig-1-3)
- [ActorCore, biblioteca de mocap](https://beforesandafters.com/2020/12/28/actorcore-a-new-3d-mocap-motion-library/)
- [Reallusion: EULA de contenido actualizado, agosto de 2025](https://discussions.reallusion.com/t/important-news-reallusion-content-eula-updated-effective-august-1st-2025/14756)
- [Reallusion: política de contenido](https://www.reallusion.com/license/content.html)
