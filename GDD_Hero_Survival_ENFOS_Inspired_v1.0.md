# GAME DESIGN DOCUMENT (GDD)
## Proyecto provisional: HERO SURVIVAL / ENFOS-INSPIRED

**Versión:** 1.0  
**Estado:** Preproducción / visión de producto  
**Uso:** Documento maestro para Claude durante el desarrollo.

> **Nota legal:** El proyecto se inspira en la estructura jugable de antiguos mapas custom de Warcraft III, especialmente el concepto ENFOS, pero debe ser un producto original. No utilizar personajes, nombres, modelos, texturas, iconos, sonidos, música, código, mapas ni otros assets de Blizzard o terceros sin licencia.

## 1. Resumen ejecutivo
Crear un videojuego standalone para PC, inicialmente orientado a Steam, basado en dos equipos que sobreviven a oleadas progresivas mientras desarrollan héroes, compran objetos y habilidades y pueden invertir recursos en perjudicar al rival.

La partida estándar tendrá **60 oleadas** y soportará **1v1, 2v2 y 3v3**. Cada jugador controla un héroe con rol, habilidades, objetos y progresión propios.

### Característica diferencial: nivel infinito
A diferencia del héroe convencional de Warcraft III, el héroe **no tendrá nivel máximo**. La experiencia y progresión son potencialmente infinitas. Cada nivel debe aportar crecimiento estadístico y, en niveles hito, nuevas habilidades, mejoras o elecciones. Después de los primeros niveles se utilizará un sistema de mastery/talentos/especialización para que la progresión continúe sin exigir una habilidad nueva en cada nivel.

## 2. Pilares
- Horde Survival.
- Hero RPG.
- Infinite Progression.
- Team Composition.
- Indirect PvP.
- Replayability.
- Clarity.
- Premium Presentation.
- Originality.

## 3. Core loop
```text
SELECCIÓN DE HÉROE
↓
PREPARACIÓN
↓
OLEADA
↓
COMBATE + XP + ORO + DROPS
↓
SUBIDA DE NIVEL / SKILLS
↓
TIENDA / BUILD
↓
SABOTAJE OPCIONAL
↓
SIGUIENTE OLEADA
↓
...
↓
OLEADA 60 / FINAL BOSS
↓
VICTORIA / DERROTA
```

## 4. Modos
- 1v1
- 2v2
- 3v3

El 2v2 y 3v3 deben ser especialmente importantes para la sinergia entre héroes.

## 5. Mapa
Dos sites simétricos, cada uno con:
- ruta de enemigos;
- zona de combate;
- Core/Portal;
- tienda de progresión;
- tienda de sabotaje;
- zona de preparación.

La simetría debe impedir ventajas iniciales derivadas de la geometría.

## 6. Victoria/derrota
Sobrevivir a las 60 oleadas. Si demasiados enemigos alcanzan el Core, el equipo pierde. La oleada 60 debe ser un encuentro final con mecánicas propias.

## 7. Oleadas
La dificultad debe aumentar mediante:
- cantidad;
- estadísticas;
- composición;
- velocidad;
- resistencias;
- habilidades;
- élites;
- minibosses;
- bosses;
- modificadores;
- eventos;
- sinergias.

Las oleadas deben soportar seeds deterministas para reproducir escenarios durante QA.

### Data model conceptual
```text
WaveDefinition
- waveNumber
- seed
- budget
- enemyPool
- compositionRules
- eliteChance
- bossRule
- modifiers
- spawnPattern
- difficultyMultiplier
```

## 8. Héroes
Objetivo final: **40–50 héroes originales**. Empezar con 2–6 en el vertical slice.

Cada héroe:
- identidad visual;
- rol;
- ataque básico;
- estadísticas;
- crecimiento por nivel;
- activas;
- pasivas;
- ultimate;
- sinergias;
- debilidades;
- builds alternativas.

Roles posibles:
Tank, Bruiser, Assassin, Ranged DPS, Archer, AoE Caster, Elementalist, Single-target, Summoner, Necromancer, Healer, Support, Controller, Hybrid.

## 9. Sistema de niveles — INFINITO
Este es un sistema nuclear.

**No existe un nivel máximo de diseño.**

El código no debe asumir `MAX_LEVEL = 10`, `50`, etc. El nivel debe ser un entero/representación robusta sin cap de diseño.

### Cada nivel
- XP → nivel.
- crecimiento estadístico;
- niveles hito → skill/talento/mejora;
- niveles intermedios → atributos, mejoras o recursos.

### Filosofía
La progresión debe recordar al sistema de héroes de Warcraft: el personaje aprende habilidades progresivamente y gana poder. La diferencia es que aquí la progresión continúa después del rango tradicional.

### Modelo recomendado
- Nivel 1: inicio + capacidad inicial.
- Niveles tempranos: habilidades principales.
- Niveles hito: habilidades/mejoras/especializaciones.
- Nivel 10+: mastery/talentos/progresión avanzada.
- Nivel 20+: especializaciones avanzadas.
- Nivel infinito: crecimiento controlado.

**No es necesario desbloquear una skill nueva en cada nivel.**

### Balance de progresión infinita
Evitar:
- números absurdos;
- overflow;
- crecimiento lineal descontrolado;
- builds que invaliden todas las demás;
- pérdida de relevancia del contenido.

Usar cuando proceda:
- curvas de crecimiento;
- diminishing returns;
- soft caps por estadística;
- mastery;
- talentos;
- contenido que escale;
- separación entre poder bruto y utilidad.

## 10. Construcción del héroe
Dos jugadores con el mismo héroe deben poder terminar con builds diferentes.

Ejemplo:
```text
PYROMANCER
A — Burn / DoT
B — Critical Fire
C — AoE
D — Mana / Ability Spam
E — Glass Cannon
```

## 11. Economía
Recompensas:
- Gold;
- XP;
- drops;
- boss rewards;
- eventos.

### Tienda de héroe
- armas;
- armaduras;
- accesorios;
- libros;
- stats;
- habilidades/mejoras;
- consumibles;
- objetos especiales.

### Tienda de sabotaje
- terremotos;
- invasiones;
- élites;
- control;
- silencios;
- debuffs;
- trampas/teleports;
- modificadores de oleada;
- eventos de caos.

Todo sabotaje debe tener **counterplay**.

## 12. Dos economías
Evaluar separar:
```text
GOLD / POWER
→ progresión personal

INFLUENCE / CHAOS
→ sabotaje
```
Esto puede evitar que cada acción ofensiva destruya la progresión propia.

## 13. Enemigos
Bestiario original con:
- melee;
- ranged;
- fast;
- tank;
- caster;
- healer;
- summoner;
- assassin;
- siege;
- elite;
- miniboss;
- boss.

Los enemigos deben diferenciarse por comportamiento, no solo estadísticas.

## 14. Bosses
Deben tener:
- patrones;
- telegraphs;
- fases;
- invocaciones;
- mecánicas de arena/ruta;
- debuffs;
- DPS checks;
- supervivencia;
- mecánicas cooperativas.

## 15. Replayability
- seeds;
- composición variable;
- eventos;
- drops;
- héroes;
- builds;
- composición de equipo;
- sabotaje;
- dificultades futuras.

## 16. Visual
Fantasia 3D estilizada, nivel de acabado de un remake moderno de un clásico de PC, pero completamente original. No copiar Warcraft III.

Objetivos:
- modelos originales;
- animaciones fluidas;
- VFX potentes pero legibles;
- iluminación;
- partículas;
- UI moderna;
- feedback de daño;
- telegraphs;
- audio contundente;
- música original/licenciada.

## 17. Cámara/UX
- top-down/isométrica 3D;
- zoom;
- seguimiento;
- input claro;
- UI escalable;
- cooldowns;
- buffs/debuffs;
- alertas del Core.

## 18. Rendimiento
Diseñar desde el principio para cientos de enemigos:
- pooling;
- LOD;
- culling;
- IA eficiente;
- updates por grupos;
- VFX pooling;
- pathfinding eficiente.

## 19. Arquitectura
```text
Gameplay
Combat
Heroes
HeroProgression
Abilities
Items
Enemies
Waves
Bosses
Economy
Shops
Sabotage
AI
UI
Audio
VFX
SaveSystem
Networking
Matchmaking
QA/Telemetry
```

Data-driven:
```text
HeroDefinition
HeroLevelCurve
AbilityDefinition
TalentDefinition
ItemDefinition
EnemyDefinition
BossDefinition
WaveDefinition
SabotageDefinition
DropTable
DifficultyDefinition
```

## 20. Multiplayer
Objetivo final: 1v1, 2v2, 3v3 online.

Preparar desde el principio para:
- sincronización;
- autoridad;
- reconexión;
- desconexiones;
- validación;
- anti-exploit.

El vertical slice puede ser single-player/local simulation.

## 21. Testing / Workers
Crear workers/agentes especializados:

1. **Gameplay QA:** partidas, oleadas, economía, progresión.
2. **Balance QA:** miles de simulaciones; héroes/builds/objetos OP.
3. **Performance QA:** 100/200/500/1.000+ unidades; CPU/GPU/memoria/frame time.
4. **Multiplayer QA:** 1v1/2v2/3v3, desync, desconexiones.
5. **UI QA:** resoluciones, escalado, input.
6. **Save/Load QA:** consistencia y recuperación.
7. **Exploit QA:** duplicación, cooldowns, economía, movimiento.
8. **Regression QA:** batería automática tras cambios.

### Definition of Done
```text
IMPLEMENTED
↓
UNIT TESTED
↓
INTEGRATION TESTED
↓
SIMULATED
↓
PLAYTESTED
↓
PERFORMANCE CHECKED
↓
REGRESSION TESTED
↓
DOCUMENTED
↓
DONE
```

## 22. Vertical Slice
No empezar con 50 héroes.

Debe incluir:
- 1 mapa;
- 2–6 héroes;
- 5–8 enemigos;
- 10 oleadas;
- 1 miniboss;
- 1 boss;
- tienda;
- niveles;
- habilidades;
- prototipo de progresión post-nivel-10;
- 1–3 sabotajes;
- victoria/derrota;
- UI;
- stress test básico.

**Criterio:** el core loop debe ser divertido con contenido limitado.

## 23. Roadmap
1. Preproduction.
2. Vertical Slice.
3. Core Systems.
4. Content Alpha.
5. PvP/Sabotage.
6. Multiplayer.
7. Content Expansion.
8. Polish.
9. Beta.
10. Steam Release Candidate.

## 24. Riesgos
- progresión infinita desbalanceada;
- snowball del sabotaje;
- rendimiento con muchas unidades;
- carga de balance de 50 héroes;
- complejidad multiplayer;
- primeras oleadas irrelevantes;
- builds demasiado parecidas;
- RNG injusto o insuficiente.

Todos deben convertirse en hipótesis testeables.

## 25. Principios para Claude
- No implementar sistemas grandes sin arquitectura.
- No producir contenido masivo antes de validar el core loop.
- No aceptar deuda técnica sin documentarla.
- Compilar ≠ terminar.
- Todo sistema crítico debe ser testeable.
- Todo contenido balanceable debe ser data-driven.
- No asumir cap de nivel.
- No resolver balance solo con multiplicadores.
- Priorizar claridad sobre VFX excesivo.
- Priorizar estabilidad y mantenibilidad.
- Documentar decisiones.
- Ante ambigüedad, presentar alternativas, riesgos y recomendación.

## 26. Primera tarea para Claude
NO crear todavía 50 héroes, 60 oleadas ni arte final.

Primero:
1. Analizar el GDD.
2. Detectar ambigüedades/riesgos.
3. Proponer motor/stack y justificarlo.
4. Diseñar arquitectura.
5. Diseñar modelo de datos para héroes, habilidades, niveles infinitos, enemigos, oleadas, objetos y sabotaje.
6. Diseñar vertical slice.
7. Crear backlog priorizado.
8. Definir testing automatizado y workers.
9. No escribir código de producción hasta documentar la arquitectura inicial.

## Regla de oro
No hacer "un clon de ENFOS con mejores gráficos". Hacer un juego original cuyo ADN jugable sea: **dos equipos + héroes + oleadas + RPG + progresión infinita + economía + defensa + sabotaje**.
