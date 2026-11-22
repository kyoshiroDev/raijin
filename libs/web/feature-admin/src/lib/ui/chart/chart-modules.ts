import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Filler,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';
import type { RjChartInstance } from './chart-loader';

/**
 * Point d'entrée du chunk Chart.js (chargé par `loadChartJs`) : imports nommés pour que seuls ces contrôleurs,
 * éléments, échelles et plugins entrent dans le bundle (un `import('chart.js')` gardait toute la bibliothèque).
 */
Chart.register(
  LineController,
  LineElement,
  PointElement,
  BarController,
  BarElement,
  DoughnutController,
  ArcElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Filler,
);

export function createChart(canvas: HTMLCanvasElement, config: ChartConfiguration): RjChartInstance {
  return new Chart(canvas, config) as unknown as RjChartInstance;
}
