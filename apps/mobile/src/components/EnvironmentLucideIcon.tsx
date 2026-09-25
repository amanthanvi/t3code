import type { EnvironmentLucideIconId } from "@t3tools/contracts";
import Svg, { Circle, Ellipse, Line, Path, Polygon, Polyline, Rect } from "react-native-svg";
import { withUniwind } from "uniwind";

import {
  ENVIRONMENT_LUCIDE_ICON_NODES,
  type LucideIconNode,
} from "./environmentLucideIcons.generated";

const ThemedSvg = withUniwind(Svg);

/**
 * Draws one of the shared Lucide icons from generated path data, on the same
 * 24 unit grid and 2 unit stroke web uses. Only the element kinds Lucide
 * ships are handled; the generator is the other half of that contract.
 */
function renderNode(node: LucideIconNode) {
  return node.map(([element, attributes]) => {
    // Nodes carry no id; the element plus its geometry is unique within one icon.
    const key = `${element}:${Object.values(attributes).join(",")}`;
    // A handful of icons fill a dot with currentColor; everything else strokes.
    const fill = attributes.fill === "currentColor" ? "currentColor" : "none";
    switch (element) {
      case "path":
        return <Path key={key} d={attributes.d} fill={fill} />;
      case "circle":
        return (
          <Circle key={key} cx={attributes.cx} cy={attributes.cy} r={attributes.r} fill={fill} />
        );
      case "rect":
        return (
          <Rect
            key={key}
            x={attributes.x}
            y={attributes.y}
            width={attributes.width}
            height={attributes.height}
            rx={attributes.rx}
            ry={attributes.ry}
            fill={fill}
          />
        );
      case "line":
        return (
          <Line
            key={key}
            x1={attributes.x1}
            y1={attributes.y1}
            x2={attributes.x2}
            y2={attributes.y2}
          />
        );
      case "polyline":
        return <Polyline key={key} points={attributes.points} fill={fill} />;
      case "polygon":
        return <Polygon key={key} points={attributes.points} fill={fill} />;
      case "ellipse":
        return (
          <Ellipse
            key={key}
            cx={attributes.cx}
            cy={attributes.cy}
            rx={attributes.rx}
            ry={attributes.ry}
            fill={fill}
          />
        );
      default:
        return null;
    }
  });
}

export function EnvironmentLucideIcon(props: {
  readonly id: EnvironmentLucideIconId;
  readonly size: number;
  readonly colorClassName: string;
  readonly accessibilityLabel?: string;
}) {
  return (
    <ThemedSvg
      accessibilityLabel={props.accessibilityLabel}
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      colorClassName={props.colorClassName}
    >
      {renderNode(ENVIRONMENT_LUCIDE_ICON_NODES[props.id])}
    </ThemedSvg>
  );
}
