import { useState, useRef, useEffect, useMemo } from "react";

// Distance helper between two percentage points
function dist(p1, p2) {
  if (!p1 || !p2) return 0;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Cubic ease-in-out for fluid acceleration and deceleration
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Calculate angle in degrees from p1 to p2 in SVG space (1000×700)
export function angleDegrees(p1, p2) {
  if (!p1 || !p2) return 0;
  const dx = ((p2.x - p1.x) / 100) * 1000;
  const dy = ((p2.y - p1.y) / 100) * 700;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/**
 * Hook to smoothly animate the live RFID tag location strictly along the defined
 * reader sequence and hallway paths.
 *
 * If intermediate readers are missed, the locator visits every intermediate reader
 * and waypoint in exact sequential order, never cutting across walls or shortcuts.
 */
export function useSmoothLocation({ currentReader, allReaders = [], baseDuration = 350 }) {
  // Sort readers strictly by sequence order so navigation sequence is always preserved
  const sortedReaders = useMemo(() => {
    if (!allReaders || !allReaders.length) return [];
    return [...allReaders].sort(
      (a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0)
    );
  }, [allReaders]);

  const targetCoords = currentReader?.coords || { x: 50, y: 50 };
  const targetSeq = currentReader?.sequence ?? 1;

  // Helper to reliably find a reader index in sortedReaders
  const getReaderIndex = (target) => {
    if (!target || !sortedReaders.length) return 0;

    // 1. Match by ID (exact or string conversion)
    if (target.id !== undefined && target.id !== null) {
      const byId = sortedReaders.findIndex(
        (r) => String(r.id) === String(target.id)
      );
      if (byId !== -1) return byId;
    }

    // 2. Match by sequence number
    if (target.sequence !== undefined && target.sequence !== null) {
      const bySeq = sortedReaders.findIndex(
        (r) => Number(r.sequence) === Number(target.sequence)
      );
      if (bySeq !== -1) return bySeq;
    }

    // 3. Match closest sequence number
    const targetSeqNum = Number(target.sequence) || 1;
    let minDiff = Infinity;
    let closestIdx = 0;
    sortedReaders.forEach((r, idx) => {
      const diff = Math.abs((Number(r.sequence) || 0) - targetSeqNum);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = idx;
      }
    });
    return closestIdx;
  };

  // State
  const [currentPos, setCurrentPos] = useState(targetCoords);
  const [currentAngle, setCurrentAngle] = useState(0);
  const [isMoving, setIsMoving] = useState(false);
  const [activeWaypointIdx, setActiveWaypointIdx] = useState(0);

  // Animation & Position Refs
  const posRef = useRef(targetCoords);
  const currentWaypointIdxRef = useRef(0);
  const targetWaypointIdxRef = useRef(0);
  const isMovingRef = useRef(false);
  const animFrameRef = useRef(null);
  const isFirstRender = useRef(true);

  // Initialize on first mount
  useEffect(() => {
    if (isFirstRender.current && sortedReaders.length > 0) {
      const initIdx = getReaderIndex(currentReader || sortedReaders[0]);
      const initialCoords = sortedReaders[initIdx]?.coords || targetCoords;

      posRef.current = initialCoords;
      currentWaypointIdxRef.current = initIdx;
      targetWaypointIdxRef.current = initIdx;
      setActiveWaypointIdx(initIdx);
      setCurrentPos(initialCoords);
      isFirstRender.current = false;

      // Face next reader on load
      if (initIdx + 1 < sortedReaders.length) {
        setCurrentAngle(angleDegrees(initialCoords, sortedReaders[initIdx + 1].coords));
      }
    }
  }, [sortedReaders]);

  // Main animation effect triggered when currentReader changes
  useEffect(() => {
    if (isFirstRender.current || !sortedReaders.length || !currentReader) return;

    const targetIdx = getReaderIndex(currentReader);

    // If target has not changed and animation is already running towards it, DO NOT interrupt!
    // (Prevents 300ms polling from interrupting the ongoing corridor path)
    if (targetIdx === targetWaypointIdxRef.current && isMovingRef.current) {
      return;
    }

    const startPos = { ...posRef.current };
    const fromIdx = currentWaypointIdxRef.current;

    // If already at target position and index, no animation required
    if (targetIdx === fromIdx && dist(startPos, sortedReaders[targetIdx].coords) < 0.05) {
      targetWaypointIdxRef.current = targetIdx;
      return;
    }

    targetWaypointIdxRef.current = targetIdx;

    // ── Build the path STRICTLY along every reader in sequence order ──────────
    // Never skip any intermediate reader or waypoint, and never cut through walls!
    const pathNodes = [startPos];
    const nodeIndices = [fromIdx];

    if (fromIdx < targetIdx) {
      // Forward progression: visit each reader/waypoint in strict sequence order
      for (let i = fromIdx; i <= targetIdx; i++) {
        const pt = sortedReaders[i].coords;
        if (dist(pathNodes[pathNodes.length - 1], pt) > 0.1) {
          pathNodes.push(pt);
          nodeIndices.push(i);
        }
      }
    } else if (fromIdx > targetIdx) {
      // Backward progression: visit each reader in reverse sequence order
      for (let i = fromIdx; i >= targetIdx; i--) {
        const pt = sortedReaders[i].coords;
        if (dist(pathNodes[pathNodes.length - 1], pt) > 0.1) {
          pathNodes.push(pt);
          nodeIndices.push(i);
        }
      }
    } else {
      pathNodes.push(sortedReaders[targetIdx].coords);
      nodeIndices.push(targetIdx);
    }

    // Clean up duplicate or near-identical adjacent nodes
    const cleanNodes = [];
    const cleanIndices = [];
    for (let i = 0; i < pathNodes.length; i++) {
      if (i === 0 || dist(cleanNodes[cleanNodes.length - 1], pathNodes[i]) > 0.05) {
        cleanNodes.push(pathNodes[i]);
        cleanIndices.push(nodeIndices[i]);
      }
    }

    if (cleanNodes.length < 2) {
      const finalCoords = sortedReaders[targetIdx].coords;
      posRef.current = finalCoords;
      setCurrentPos(finalCoords);
      currentWaypointIdxRef.current = targetIdx;
      setActiveWaypointIdx(targetIdx);
      setIsMoving(false);
      isMovingRef.current = false;
      return;
    }

    // Calculate segment distances and cumulative path distance
    const segmentDists = [];
    const cumDists = [0];
    let totalPathDist = 0;

    for (let i = 0; i < cleanNodes.length - 1; i++) {
      const segDist = dist(cleanNodes[i], cleanNodes[i + 1]);
      segmentDists.push(segDist);
      totalPathDist += segDist;
      cumDists.push(totalPathDist);
    }

    if (totalPathDist < 0.05) {
      const finalCoords = sortedReaders[targetIdx].coords;
      posRef.current = finalCoords;
      setCurrentPos(finalCoords);
      currentWaypointIdxRef.current = targetIdx;
      setActiveWaypointIdx(targetIdx);
      setIsMoving(false);
      isMovingRef.current = false;
      return;
    }

    // Scale duration with the number of reader hops so traversing multiple missed readers
    // moves at a steady, natural walking pace along the corridor (e.g. ~320ms per hop)
    const hopCount = Math.max(1, Math.abs(targetIdx - fromIdx));
    const moveDuration = Math.min(Math.max(hopCount * baseDuration, 350), 3000);

    const startTime = performance.now();
    setIsMoving(true);
    isMovingRef.current = true;

    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
    }

    const animate = (now) => {
      const elapsed = now - startTime;
      const rawProgress = Math.min(1, elapsed / moveDuration);
      const easedProgress = easeInOutCubic(rawProgress);
      const currentDist = easedProgress * totalPathDist;

      // Find active segment
      let segIdx = 0;
      for (let i = 0; i < segmentDists.length; i++) {
        if (currentDist >= cumDists[i] && currentDist <= cumDists[i + 1]) {
          segIdx = i;
          break;
        }
      }

      const segStartDist = cumDists[segIdx];
      const segLen = segmentDists[segIdx] || 0.0001;
      const segFraction = Math.min(1, Math.max(0, (currentDist - segStartDist) / segLen));

      const pA = cleanNodes[segIdx];
      const pB = cleanNodes[segIdx + 1];

      const currentX = pA.x + segFraction * (pB.x - pA.x);
      const currentY = pA.y + segFraction * (pB.y - pA.y);
      const currentAngleDeg = angleDegrees(pA, pB);

      const newPos = { x: currentX, y: currentY };
      posRef.current = newPos;
      setCurrentPos(newPos);
      setCurrentAngle(currentAngleDeg);

      // Track the node index reached as the pin passes each reader checkpoint
      const currentHopIdx = cleanIndices[segIdx];
      if (currentHopIdx !== undefined && currentHopIdx !== currentWaypointIdxRef.current) {
        currentWaypointIdxRef.current = currentHopIdx;
        setActiveWaypointIdx(currentHopIdx);
      }

      if (rawProgress < 1) {
        animFrameRef.current = requestAnimationFrame(animate);
      } else {
        const finalCoords = sortedReaders[targetIdx].coords;
        posRef.current = finalCoords;
        setCurrentPos(finalCoords);
        currentWaypointIdxRef.current = targetIdx;
        setActiveWaypointIdx(targetIdx);
        setIsMoving(false);
        isMovingRef.current = false;

        // Angle to face next reader upon arrival
        if (targetIdx + 1 < sortedReaders.length) {
          setCurrentAngle(angleDegrees(finalCoords, sortedReaders[targetIdx + 1].coords));
        }
      }
    };

    animFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [currentReader?.id, currentReader?.sequence, sortedReaders, baseDuration]);

  // Compute dynamic passed and remaining paths strictly along the reader corridor route
  const { passedPoints, remainingPoints } = useMemo(() => {
    if (!sortedReaders.length) return { passedPoints: [], remainingPoints: [] };

    const curIdx = activeWaypointIdx;

    // 1. All readers passed in sequence order up to curIdx, plus current pin position
    const passed = [];
    for (let i = 0; i <= curIdx; i++) {
      if (i < sortedReaders.length) {
        passed.push(sortedReaders[i].coords);
      }
    }
    passed.push(currentPos);

    // 2. All remaining upcoming readers in sequence order starting from current pin position
    const remaining = [currentPos];
    for (let i = curIdx + 1; i < sortedReaders.length; i++) {
      remaining.push(sortedReaders[i].coords);
    }

    return { passedPoints: passed, remainingPoints: remaining };
  }, [sortedReaders, activeWaypointIdx, currentPos]);

  const activeSeq = sortedReaders[activeWaypointIdx]?.sequence ?? targetSeq;

  return {
    currentPos,
    currentAngle,
    isMoving,
    passedPoints,
    remainingPoints,
    activeWaypointIdx,
    activeSeq,
  };
}
