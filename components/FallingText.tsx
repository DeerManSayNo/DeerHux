"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Matter from "matter-js";

import "./FallingText.css";

type Trigger = "click" | "hover" | "auto" | "scroll";
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

type FallingTextProps = {
  className?: string;
  text: string;
  ariaLabel?: string;
  highlightWords?: string[];
  highlightClass?: string;
  trigger?: Trigger;
  backgroundColor?: string;
  wireframes?: boolean;
  gravity?: number;
  mouseConstraintStiffness?: number;
  fontSize?: string;
  wordSpacing?: string;
  floorSelector?: string;
  floorGap?: number;
  bounceOnClick?: boolean;
  bounceStrength?: number;
  bounceRadius?: number;
};

export default function FallingText({
  className = "",
  text,
  ariaLabel,
  highlightWords = [],
  highlightClass = "highlighted",
  trigger = "auto",
  backgroundColor = "transparent",
  wireframes = false,
  gravity = 1,
  mouseConstraintStiffness = 0.2,
  fontSize = "1rem",
  wordSpacing = "2px",
  floorSelector,
  floorGap = 0,
  bounceOnClick = false,
  bounceStrength = 10,
  bounceRadius = 120,
}: FallingTextProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const [effectStarted, setEffectStarted] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const words = text.split(/\s+/).filter(Boolean);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotionPreference = () => setPrefersReducedMotion(media.matches);
    updateMotionPreference();
    media.addEventListener?.("change", updateMotionPreference);
    return () => media.removeEventListener?.("change", updateMotionPreference);
  }, []);

  useEffect(() => {
    if (prefersReducedMotion) return;
    if (trigger === "auto") {
      setEffectStarted(true);
      return;
    }
    if (trigger !== "scroll" || !containerRef.current) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setEffectStarted(true);
      observer.disconnect();
    }, { threshold: 0.1 });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [prefersReducedMotion, trigger]);

  useEffect(() => {
    const container = containerRef.current;
    const canvasContainer = canvasContainerRef.current;
    if (!effectStarted || prefersReducedMotion || !container || !canvasContainer) return;

    const containerRect = container.getBoundingClientRect();
    const width = containerRect.width;
    const height = containerRect.height;
    if (width <= 0 || height <= 0) return;

    const floorRoot = container.parentElement;
    const resolveFloorTarget = () => floorSelector
      ? floorRoot?.querySelector<HTMLElement>(floorSelector) ?? null
      : null;
    const resolveFloorY = (rect: DOMRect) => {
      const floorTarget = resolveFloorTarget();
      if (!floorTarget) return rect.height;
      return clamp(floorTarget.getBoundingClientRect().top - rect.top - floorGap, 50, rect.height);
    };
    const floorY = resolveFloorY(containerRect);

    const { Engine, Render, World, Bodies, Runner, Mouse, MouseConstraint, Body } = Matter;
    const engine = Engine.create();
    engine.world.gravity.y = gravity;

    const render = Render.create({
      element: canvasContainer,
      engine,
      options: { width, height, background: backgroundColor, wireframes },
    });

    const boundaryOptions = { isStatic: true, render: { fillStyle: "transparent" } };
    const floor = Bodies.rectangle(width / 2, floorY + 25, width, 50, boundaryOptions);
    const leftWall = Bodies.rectangle(-25, floorY / 2, 50, floorY, boundaryOptions);
    const rightWall = Bodies.rectangle(width + 25, floorY / 2, 50, floorY, boundaryOptions);
    const ceiling = Bodies.rectangle(width / 2, -25, width, 50, boundaryOptions);
    const boundaries = [floor, leftWall, rightWall, ceiling];

    const wordElements = Array.from(container.querySelectorAll<HTMLElement>(".falling-text__word"));
    const wordBodies = wordElements.map((element) => {
      const rect = element.getBoundingClientRect();
      const body = Bodies.rectangle(
        rect.left - containerRect.left + rect.width / 2,
        rect.top - containerRect.top + rect.height / 2,
        rect.width,
        rect.height,
        {
          render: { fillStyle: "transparent" },
          restitution: 0.8,
          frictionAir: 0.01,
          friction: 0.2,
        },
      );
      Body.setVelocity(body, { x: (Math.random() - 0.5) * 5, y: 0 });
      Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.05);
      element.style.position = "absolute";
      return { element, body };
    });

    const mouse = Mouse.create(container);
    const mouseConstraint = MouseConstraint.create(engine, {
      mouse,
      constraint: {
        stiffness: mouseConstraintStiffness,
        render: { visible: false },
      },
    });
    render.mouse = mouse;

    World.add(engine.world, [...boundaries, mouseConstraint, ...wordBodies.map(({ body }) => body)]);

    const runner = Runner.create();
    Runner.run(runner, engine);
    Render.run(render);

    let currentWidth = width;
    let currentHeight = height;
    let currentFloorY = floorY;
    const resizeObserver = new ResizeObserver(() => {
      const nextRect = container.getBoundingClientRect();
      const nextWidth = nextRect.width;
      const nextHeight = nextRect.height;
      const nextFloorY = resolveFloorY(nextRect);
      if (nextWidth <= 0 || nextHeight <= 0) return;
      if (Math.abs(nextWidth - currentWidth) < 1
        && Math.abs(nextHeight - currentHeight) < 1
        && Math.abs(nextFloorY - currentFloorY) < 1) return;

      Render.setSize(render, nextWidth, nextHeight);
      Body.scale(floor, nextWidth / currentWidth, 1);
      Body.scale(ceiling, nextWidth / currentWidth, 1);
      Body.scale(leftWall, 1, nextFloorY / currentFloorY);
      Body.scale(rightWall, 1, nextFloorY / currentFloorY);
      Body.setPosition(floor, { x: nextWidth / 2, y: nextFloorY + 25 });
      Body.setPosition(ceiling, { x: nextWidth / 2, y: -25 });
      Body.setPosition(leftWall, { x: -25, y: nextFloorY / 2 });
      Body.setPosition(rightWall, { x: nextWidth + 25, y: nextFloorY / 2 });

      for (const { body } of wordBodies) {
        const halfWidth = (body.bounds.max.x - body.bounds.min.x) / 2;
        const halfHeight = (body.bounds.max.y - body.bounds.min.y) / 2;
        Body.setPosition(body, {
          x: clamp(body.position.x, halfWidth, Math.max(halfWidth, nextWidth - halfWidth)),
          y: clamp(body.position.y, halfHeight, Math.max(halfHeight, nextFloorY - halfHeight)),
        });
      }

      currentWidth = nextWidth;
      currentHeight = nextHeight;
      currentFloorY = nextFloorY;
    });
    resizeObserver.observe(container);
    const floorTarget = resolveFloorTarget();
    if (floorTarget) {
      resizeObserver.observe(floorTarget);
      if (floorTarget.parentElement) resizeObserver.observe(floorTarget.parentElement);
    }

    const handleBounce = (event: globalThis.MouseEvent) => {
      if (!bounceOnClick) return;
      const rect = container.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const radius = Math.max(20, bounceRadius);
      const strength = Math.max(4, bounceStrength);

      for (const { body } of wordBodies) {
        const deltaX = body.position.x - point.x;
        const deltaY = body.position.y - point.y;
        const distance = Math.hypot(deltaX, deltaY);
        if (distance > radius) continue;

        const influence = 1 - distance / radius;
        const horizontalDirection = distance > 0 ? deltaX / distance : 0;
        const verticalVelocity = strength * (0.45 + influence * 0.55);
        Body.setVelocity(body, {
          x: body.velocity.x + horizontalDirection * strength * 0.45 * influence,
          y: Math.min(body.velocity.y, -verticalVelocity),
        });
        Body.setAngularVelocity(
          body,
          body.angularVelocity + clamp(deltaX / radius, -1, 1) * 0.12 * (0.4 + influence * 0.6),
        );
      }
    };
    container.addEventListener("click", handleBounce);

    let animationFrame = 0;
    const syncWords = () => {
      for (const { body, element } of wordBodies) {
        element.style.left = `${body.position.x}px`;
        element.style.top = `${body.position.y}px`;
        element.style.transform = `translate(-50%, -50%) rotate(${body.angle}rad)`;
      }
      animationFrame = requestAnimationFrame(syncWords);
    };
    syncWords();

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      container.removeEventListener("click", handleBounce);
      Render.stop(render);
      Runner.stop(runner);
      Mouse.clearSourceEvents(mouse);
      render.canvas.remove();
      World.clear(engine.world, false);
      Engine.clear(engine);
      for (const { element } of wordBodies) {
        element.style.position = "";
        element.style.left = "";
        element.style.top = "";
        element.style.transform = "";
      }
    };
  }, [backgroundColor, bounceOnClick, bounceRadius, bounceStrength, effectStarted, floorGap, floorSelector, fontSize, gravity, mouseConstraintStiffness, prefersReducedMotion, text, wireframes, wordSpacing]);

  const startEffect = () => {
    if (!prefersReducedMotion && !effectStarted && (trigger === "click" || trigger === "hover")) {
      setEffectStarted(true);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (trigger !== "click" || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    startEffect();
  };

  return (
    <div
      ref={containerRef}
      className={`falling-text-container ${className}`.trim()}
      data-effect-started={effectStarted || undefined}
      onClick={trigger === "click" ? startEffect : undefined}
      onMouseEnter={trigger === "hover" ? startEffect : undefined}
      onKeyDown={trigger === "click" ? handleKeyDown : undefined}
      role={trigger === "click" ? "button" : undefined}
      tabIndex={trigger === "click" ? 0 : undefined}
      aria-label={ariaLabel}
    >
      <div className="falling-text-target" style={{ fontSize, lineHeight: 1.4 }} aria-hidden={ariaLabel ? true : undefined}>
        {words.map((word, index) => {
          const highlighted = highlightWords.some((highlight) => word.startsWith(highlight));
          return (
            <span
              className={`falling-text__word${highlighted ? ` ${highlightClass}` : ""}`}
              key={`${word}-${index}`}
              style={{ marginInline: wordSpacing }}
            >
              {word}
            </span>
          );
        })}
      </div>
      <div ref={canvasContainerRef} className="falling-text-canvas" aria-hidden="true" />
    </div>
  );
}
