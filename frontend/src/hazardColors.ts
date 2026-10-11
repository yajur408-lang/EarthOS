import type { HazardType } from './api'

export const HAZARD_COLORS: Record<HazardType, string> = {
  cyclone: '#7b1fa2', tornado: '#5d4037', earthquake: '#e53935', wildfire: '#ef6c00', volcano: '#b71c1c',
  flood: '#1e88e5', landslide: '#8d6e63', storm: '#3949ab', drought: '#f9a825',
}
