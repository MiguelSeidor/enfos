# ¿Migrar a Unity o Unreal? Análisis

Escrito a petición explícita: *"Estudiemoslo… vamos a analizar si realmente es
viable o necesario."*

Conclusión primero, razonamiento después.

---

## Conclusión

**El motor no es el problema. El problema es que decidimos no usar assets.**

Recomiendo **quedarnos en Three.js y levantar la restricción de arte 100 %
procedural**, cargando modelos glTF. Eso ataca la causa real y conserva las
~15.000 líneas de juego que ya funcionan.

Migrar a Unity o Unreal es viable, pero es **empezar de cero** y no resuelve el
problema que te molesta.

---

## Por qué los héroes parecen "polígonos unos encima de otros"

No es una limitación de Three.js. Es una consecuencia directa de una decisión que
tomamos el primer día, siguiendo la nota legal del GDD:

> No utilizar personajes, nombres, modelos, texturas, iconos, sonidos, música,
> código, mapas ni otros assets de Blizzard o terceros sin licencia.

Lo interpreté de la forma más estricta posible: **cero assets externos, todo
generado por código**. Por eso los personajes son ensamblajes de primitivas con
esqueleto procedural. Con esa restricción, el resultado actual es más o menos el
techo: nadie construye un personaje AAA con cilindros y cajas, ni en Three.js ni
en Unreal.

La nota del GDD prohíbe **assets de terceros sin licencia**. No prohíbe assets
propios, comprados, licenciados o generados por IA. Esa distinción es la que
abre la puerta.

---

## Qué aporta realmente cada motor

| | Three.js (actual) | Unity | Unreal |
| --- | --- | --- | --- |
| Renderizado PBR, sombras, post | Sí, ya funciona | Sí | Sí, superior |
| Carga de modelos glTF/FBX | **Sí** | Sí | Sí |
| Animación con esqueleto e IK | Básico, a mano | Bueno (Mecanim) | Excelente |
| Físicas | Hay que integrarlas | Incluidas | Incluidas |
| Tienda de assets | No propia | Enorme | Grande |
| Iluminación avanzada | Manual | Buena | Lumen, Nanite |
| Distribución en Steam | Vía Electron/Tauri | Nativa | Nativa |
| Multijugador | A mano | Netcode | Replicación integrada |

Lo importante de esa tabla: **la fila que resuelve tu queja — cargar modelos
buenos — ya la tenemos**. Three.js carga glTF desde siempre.

Lo que Unity/Unreal aportarían de verdad es el **toolchain**: editor visual,
animación con retargeting, físicas y replicación de red ya resueltas.

---

## El coste real de migrar

Lo que se conserva:

- El GDD y todas las decisiones de diseño.
- Las tablas de balance (estadísticas, oleadas, costes, curvas).
- El trazado del mapa: son coordenadas, se reimplementan.

Lo que se tira, porque es específico de Three.js/TypeScript:

| Sistema | Estado | ¿Se salva? |
| --- | --- | --- |
| Motor determinista a paso fijo | Funcionando | No |
| Terreno aterrazado, acantilados, validador | Funcionando | Solo las coordenadas |
| Síntesis procedural de texturas (~2.500 líneas) | Funcionando | No — deja de tener sentido |
| Constructor de personajes, rig, VAT | Funcionando | No |
| Combate, IA, oleadas, habilidades | Funcionando y verificado | Se reescribe con la misma lógica |
| HUD, minimapa, selección de héroe | Funcionando | No |
| Arnés de captura y validación visual | Funcionando | No |
| Pipeline de render y post | Funcionando | No |

Estimación honesta: **entre el 70 % y el 80 % del código escrito se pierde**. No
es "portar", es rehacer.

Y hay un coste que se subestima siempre: **volver al punto actual**. Hoy tienes
oleadas, combate, IA con cuatro comportamientos, habilidades con recargas,
economía, HUD funcional y un mapa validado. Recuperar eso en otro motor no es
inmediato aunque las decisiones ya estén tomadas.

---

## Cuándo SÍ merecería la pena migrar

No quiero venderte el statu quo. Migraría sin dudar si se diera alguno de estos:

1. **Físicas de verdad** — ragdolls, destrucción, proyectiles con colisión
   continua. Hoy no las necesitamos; el juego es cenital con movimiento en un
   plano.
2. **Multijugador con autoridad de servidor y predicción**. Unreal lo trae
   resuelto; en Three.js hay que construirlo. Es el argumento **más fuerte** a
   favor de migrar, y conviene decidirlo *antes* de escribir el netcode.
3. **Volumen de contenido**: 50 héroes con animaciones propias. Sin editor
   visual, montar eso a mano se hace muy cuesta arriba.
4. **Fidelidad gráfica de gama alta** — Lumen, Nanite, iluminación global.
   Aunque para una cámara cenital a 40 m el retorno es mucho menor de lo que
   parece: a esa distancia no ves el detalle que justifica Nanite.

Los puntos 2 y 3 son reales y llegarán. La pregunta no es *si* migrar, sino
*cuándo* — y hacerlo ahora significa tirar trabajo que aún no ha dado su
rendimiento.

---

## La alternativa que recomiendo

**Levantar la restricción procedural y cargar glTF en el proyecto actual.**

Trabajo necesario, concreto:

1. Añadir `GLTFLoader` y un gestor de assets con caché. Three.js lo trae de
   serie; es un día de trabajo, no una migración.
2. Sustituir `buildCharacter()` por un cargador que lea glTF y reutilice el
   `UnitViewModule` que ya existe: héroes con malla propia, creeps instanciados.
3. Mantener el pipeline procedural para el **terreno**, donde de hecho funciona
   bien y evita repetición.

De dónde salen los modelos, por orden de coste:

| Vía | Coste | Calidad | Notas |
| --- | --- | --- | --- |
| **Generación 3D por IA** | Baja | Media | En esta sesión hay una herramienta de generación 3D disponible. Malla + textura desde texto o imagen. Calidad irregular pero mejora mucho lo actual |
| **Assets con licencia** (Sketchfab, Quaternius, Kenney) | Baja/media | Media/alta | Muchos CC0. Hay que verificar licencia uno a uno |
| **Encargo a artista** | Alta | Alta | La única vía a AAA de verdad |
| **Mixamo** para animaciones | Gratis | Alta | Animaciones humanoides con retargeting, gratis con cuenta Adobe |

La combinación **glTF con licencia + animaciones de Mixamo + nuestro terreno
procedural** sube el listón visual muchísimo, y cuesta una fracción de una
migración.

---

## Sobre el prompt de assets que te pasé

Tenías razón en la queja implícita: ese documento cubre **retratos, iconos y
hojas de referencia 2D**, y lo dice en la primera tabla. No cubre modelos 3D,
porque un generador de imágenes no los produce.

Para 3D hace falta otra vía: generación 3D por IA, o glTF con licencia. Si
quieres, preparo un segundo documento con el flujo concreto: qué pedir, en qué
formato, qué escala, cómo orientar el pivote y qué convención de esqueleto usar
para que encaje con el `UnitViewModule` sin tocar gameplay.

---

## Recomendación final

1. **No migrar ahora.** Migrar por calidad visual sería tratar el síntoma.
2. **Levantar la restricción procedural** e integrar glTF. Es el desbloqueo real
   y conserva lo que funciona.
3. **Reevaluar antes del netcode.** Ahí sí el argumento cambia de peso, y es el
   momento natural para decidir en firme.
