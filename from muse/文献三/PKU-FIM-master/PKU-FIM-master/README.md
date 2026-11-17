# Incorporating human dynamics for cost-effective emergency resource allocation against floods

This repository contains the source code and datasets for the research article, "Incorporating human dynamics for cost-effective emergency resource allocation against floods". 

## Repository Structure

The repository is organized into two main directories: `Code` and `Datasets`.

```

.
├── Code/
│   ├── 0_DataLearning/
│   ├── 1_DataPreparation/
│   ├── 2_DataAnalysis/
│   ├── 3_BatchData/
│   ├── 4_Pic/
│   └── 5_Datasets/
├── Datasets/
│   ├── 1-km inflow mobility datasets during 1-in-100-year rainfall events/
│   ├── 1-km resolution map for the demand-supply relationship for emergency resources/
│   └── SHP/
│── Input for demo/
├── README.md
└── LICENSE.txt

````

## System Requirements

The modeling and simulations for this research were computationally intensive. While the scripts are written in **Python** and should be adaptable, they were developed and tested on a specific high-performance computing environment.

* **Operating System**: The system was developed and tested on **GNU/Linux Ubuntu 18.04.6 LTS**.
* **Python Version**: 2.7, 3.8, 3.9
* **Hardware (Development Environment)**: All simulations were conducted on a high-performance server with the following specifications:
    * **Processor**: Two AMD EPYC 7T83 64-core processors.
    * **Memory (RAM)**: 512 GB DDR4 RAM.
    * **Storage**: 16 TB SSD.
* **Hardware (Recommended Minimum)**: For running smaller-scale analyses (e.g., for a single city), a standard workstation with a multi-core processor and at least 16 GB of RAM is recommended.
* **Software Dependencies**:
    * `pandas`
    * `geopandas`
    * `numpy`
    * `rasterio`
    * `matplotlib`
    * `scikit-learn`
    * `arcpy`.
    * `math`
    * `csv`
    * `seaborn`
    * `hdbscan`

## Installation Guide

1.  **Clone the repository**:
    ```bash
    git clone [https://github.com/WeiLyu59/ABM.git](https://github.com/WeiLyu59/ABM.git)
    cd ABM
    ```

2.  **Set up a virtual environment** (recommended):
    ```bash
    conda create -n flood_abm python=3.8
    conda activate flood_abm
    ```

3.  **Install dependencies**:
    ```bash
    pip install pandas geopandas numpy rasterio matplotlib scikit-learn seaborn hdbscan
    ```
    The installation time for these packages on a normal desktop computer is typically 10-15 minutes.

## Code Description

This directory contains all the Python scripts used for data processing, analysis, and visualization in this study.

* **`0_DataLearning/`**: Contains scripts for exploratory data analysis in the early stage of this research, building upon previous research foundations.
* **`1_DataPreparation/`**: Includes scripts for processing mobile signaling data used in model calibration and validation. It also covers the geocoding and spatial association of emergency shelters for the calibration and validation cases.
* **`2_DataAnalysis/`**: Holds the core data analysis scripts. This includes the calculation of performance metrics, inflow prediction statistics, per-shelter accommodation needed, demand-supply matching statistics, spatial pattern analysis of matching results, and cost-benefit analysis.
* **`3_BatchData/`**: Contains scripts for the batch processing of homogeneous geospatial data for 21 cities. This includes geocoding shelter data, creating fishnet grids, and rasterizing precipitation, rooftop, and population data to generate inputs for the proposed ABM.
* **`4_Pic/`**: Provides the visualization code for generating all figures presented in the main text and supplementary information of the article.
* **`5_Datasets/`**: Contains scripts for organizing and structuring the two final datasets produced by this study into a clear, structured format.

## Reproduction Instructions and Usage

This section provides instructions for reproducing the quantitative results in the manuscript. The core of the analysis is an ABM built using the pseudocode from Supplementary Algorithms 1-9 to simulate flood-induced mobility.

### Step 1: Simulating Flood-Induced Mobility

1.  **Input Data**: The model requires initial information (in folder `Input for demo`) such as population, rooftops, and flood inundation maps.
2.  **Run Simulation**: Execute the core ABM script. Agents' decisions are governed by three rules: **repulsion** from hazards, **attraction** to safe areas, and **herding** with peers. The simulation generates inflow information for each city grid for every generation of the simulation.
    * **Output**: Per-generation inflow mobility data for each grid.

### Step 2: Calculating Average Inflow and Demand-Supply Matching

1.  **Calculate Average Inflow**: Use the script `2_DataAnalysis/3_PredictedInflow.py` to process the raw simulation output and calculate the average inflow for each grid during the disaster period.
2.  **Calculate Matching Relationship**: Use `2_DataAnalysis/5_match_stats.py` along with shelter location data to compare sheltering demand (predicted inflow) with resource supply (shelter capacity). This quantifies the demand-supply relationship (deficit, surplus, or balance) for each grid.
3.  **Analyze Spatial Patterns**: Use the `2_DataAnalysis/x_SP_xx.py` series of scripts to analyze the spatial patterns of the matching results.

### Step 3: Future Projection (SSP5-8.5 Scenario)

1.  **Prepare Future Data**: To run future projections, replace the current geospatial datasets with the SSP5-8.5 scenario datasets for the year 2050. This includes future population data, land cover projections, and precipitation projections.
2.  **Process Geospatial Data**: Use the scripts in the `3_BatchData/x_SSP_xx.py` series to perform the necessary processing on the future scenario data.
    * **Output**: Gridded model inputs for the ABM under the future scenario.
3.  **Re-run Simulation**: Repeat Step 1 and 2 using the newly generated future-scenario inputs.

### Step 4: Cost-Benefit Analysis (CBA)

1.  **Calculate Costs and Benefits**: After identifying resource deficit areas, run the `2_DataAnalysis/x_CBA_xx.py` series of scripts to evaluate the proposed strategy of retrofitting the top 30% of high-deficit zones.
    * **Input**: Demand-supply matching results and economic parameter data.
    * **Methodology**: The analysis incorporates 1,000 bootstrap experiments to account for spatial uncertainty and derive 95% confidence intervals. Costs include construction, maintenance, and insurance, while benefits are societal, economic, and environmental gains.
    * **Output**: A comprehensive breakdown of the costs and benefits for the proposed retrofitting strategy.

### Runtime

* The runtime for each city is determined by its geographic area and initial population. A full run of the agent-based simulation for all 21 cities takes approximately **3 days** on the high-performance hardware described above.

## Datasets

This directory provides the key datasets generated and used in this research.

1.  **1-km inflow mobility datasets during 1-in-100-year rainfall events**: This dataset captures 1-km inflow mobility using the proposed ABM under 1-in-100-year extreme rainfall scenarios.
2.  **1-km resolution map for the demand-supply relationship for emergency resources**: This dataset illustrates the spatial relationship between resource demand and supply (i.e., deficit, surplus, and balance).
3.  **`SHP/`**: This sub-directory contains the gridded shapefiles for 21 cities. These files are essential for spatially locating and interpreting the grid IDs used in the CSV datasets.


