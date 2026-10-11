# Flujo de assets por IA — probado, con números

No es teoría. Generé un personaje de punta a punta y estos son los resultados
medidos.

---

## Lo que funciona

```
prompt de texto ──> imagen 2D ──> malla GLB ──> nuestro cargador ──> escena
     images_generate   models3d_generate   src/assets/models.ts
```

Verificado con el héroe Bulwark:

| Paso | Resultado |
| --- | --- |
| Imagen 2D | 2 variantes, ~42 s |
| Imagen → GLB | 4,98 MB, con textura |
| Carga en el motor | **194 ms**, 1 malla, 1 material |
| Altura en mundo | 1,80 m con escala 1,798 |

El camino de carga está validado. `tools/fetch-asset.mjs` descarga el GLB y
mide lo que importa: triángulos, esqueletos, animaciones, caja envolvente y
posición del pivote — y sugiere la escala.

---

## Los dos problemas que encontré

### 1. No trae esqueleto ni animaciones

```
glTF: 2 nodes, 1 meshes, 96650 triangles, 0 skins
animations: none — needs rigging before it can walk
```

Probé el modelo con auto-rigging (`tripo-p1`) **y falló**:

```
Tripo task rig ended with status: failed
```

Sospecha razonable: el escudo y el martillo rompen la silueta humanoide que el
auto-rigger espera. `trellis-2` sí produjo la malla, pero no riggea en absoluto.

**Consecuencia**: tal cual, un personaje generado por IA es una **estatua**. En
el juego sustituiría un héroe que hoy camina, ataca y lanza hechizos por uno que
se desliza sin mover las piernas. Eso es mejorar el aspecto y empeorar la
animación.

### 2. 96.650 triángulos es demasiado

Nuestro presupuesto es 2,5 M de triángulos en pantalla para **todo el mundo**.

| Uso | Coste |
| --- | --- |
| 1 héroe | 96 k — aceptable |
| 8 personajes, uno de cada | 773 k — ya un tercio del presupuesto |
| Una oleada de 40 creeps | **3,9 M** — imposible |

Los creeps necesitan decimación a 3–8 k. `faceLimit` en la generación ayuda
(`tripo-p1` acepta 100–20.000), pero bajar de 96 k a 5 k conservando la silueta
requiere decimar de verdad, no solo pedir menos caras.

### 3. Pivote centrado, no en los pies

`min Y = -0.501`: la malla está centrada en su caja, así que se hunde media
altura. Ya está resuelto en el cargador con `originOffset`, pero hay que medirlo
por cada asset — de ahí que la herramienta lo imprima.

---

## Dónde SÍ vale la pena ya

**Estructuras y props.** Son estáticos, hay una instancia de cada, y es donde lo
procedural se ve más pobre: cajas y conos para las tiendas, un octaedro para el
Núcleo. Un GLB generado ahí es una mejora inmediata sin ningún inconveniente:

- Núcleo (cristal y pedestal)
- Las dos tiendas
- Los portales de aparición
- Rocas, árboles, ruinas

**Retratos e iconos.** `images_generate` los produce directamente y son
usables tal cual (ver `docs/ASSET_PROMPT.md`).

---

## Personajes: tres caminos, con su coste

| Vía | Animación | Esfuerzo | Cuándo |
| --- | --- | --- | --- |
| **Mixamo** — subir la malla, auto-rig + biblioteca de animaciones | Sí, buena | Tú, manual, por personaje | Es el camino estándar y el que recomiendo |
| **Reintentar auto-rig** con imagen en A-pose limpia, sin escudo ni arma en mano | Puede que sí | Bajo, pero incierto | Merece un intento: armas como nodos separados |
| **Malla IA + nuestro rig procedural** | Sí, la que ya tenemos | Alto | Requiere generar pesos de piel sobre una malla arbitraria |

Mixamo necesita cuenta de Adobe y es trabajo manual tuyo: subir el `.glb`,
marcar articulaciones si lo pide, elegir animaciones (idle, walk, run, attack,
cast, death), descargar y pasármelo. Yo lo cableo.

---

## Prompt que funcionó

Para malla, no para concept art. Lo que importa: figura aislada, pose simétrica,
**sin sombras proyectadas**, fondo plano, y todo el cuerpo dentro del encuadre.

```
Full-body character turnaround reference of <PERSONAJE>, front view, standing
straight in a symmetrical A-pose with arms angled slightly away from the body and
legs shoulder-width apart. Stylised dark-fantasy game art with chunky exaggerated
proportions: <RASGOS>. <MATERIALES Y PALETA>. Hand-painted stylised look,
mid-saturation palette, clean readable silhouette. Neutral even frontal lighting,
absolutely no cast shadows and no ground shadow, no dramatic rim light. Plain flat
mid-grey background, no scenery, no floor, no text, no logos. Entire figure fully
inside frame with margin around it. Original character design, not resembling any
existing game franchise.
```

Ajuste pendiente de probar: **quitar el escudo y el arma de las manos** y pedir
brazos claramente separados del torso, para darle al auto-rigger la silueta que
espera.

---

## Coste

Aproximado por personaje, con lo observado:

| Paso | Créditos |
| --- | --- |
| 2 variantes de imagen | 150 |
| Imagen → 3D (`trellis-2`) | 730 |
| Imagen → 3D (`tripo-p1`, con rig) | 775 |

El intento con rig que falló **también se cobró**. Conviene validar el prompt en
imagen antes de gastar en 3D.

---

## Lo que registré

`public/models/bulwark.glb` está descargado y en el manifiesto, con escala y
offset medidos. **Falta anotar su licencia** en `public/models/LICENSES.md`:
generado por IA a partir de un prompt nuestro, así que la autoría es nuestra —
pero hay que dejar constancia de la herramienta y la fecha, que es justamente lo
que exige la política.
