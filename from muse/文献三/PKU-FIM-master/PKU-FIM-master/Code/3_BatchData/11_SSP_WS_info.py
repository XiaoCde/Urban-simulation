# -*-coding:utf-8 -*-
# python 2.7
# Watershed info


"""
# @File       : 11_SSP_WS_info.py
# @software   : PyCharm  
# @Time       ：2025/5/21 10:57
# @Author     ：Wei Lyu
"""

import arcpy
from arcpy.sa import *
import pandas as pd
import csv

arcpy.env.overwriteOutput = True
arcpy.CheckOutExtension("Spatial")

if __name__ == '__main__':
    # 设置路径
    base_path = r"D:\LW\ABM"
    arcpy.env.workspace = base_path

    cities = pd.read_csv(base_path + r'\OutputData\cities_21\cities21_pop_CH.csv', header=None, encoding='gbk')
    cities_ch = cities[0].tolist()
    cities_en = cities[3].tolist()
    del cities

    # # Runoff coefficient 栅格映射
    # remap = RemapValue([
    #     [1, 0.25465],
    #     [2, 0.04898333],
    #     [3, 0.10155],
    #     [4, 1.0],
    #     [5, 1.0],
    #     [6, 0.0],
    # ])
    #
    # prec = base_path + r'\OutputData\Pre_SSP\years_mean_1950_2050.tif'
    # landcover = Raster(base_path + r'\Data\LC_SSP\ssp5_85_2050_CN.tif')

    # runoff coefficient
    # runoff_coeff_raster = Reclassify(landcover, "Value", remap)
    # runoff_coeff_raster.save(base_path + r'\OutputData\LC_SSP\ssp_85_2050_CN_rc.tif')

    # # runoff = prec * runoff_coeff
    # runoff_coeff_raster = base_path + r'\OutputData\LC_SSP\ssp_85_2050_CN_rc.tif'
    # runoff = Raster(prec) * runoff_coeff_raster
    # runoff.save(base_path + r'\OutputData\LC_SSP\ssp_85_2050_CN_runoff.tif')
    #
    # watershed_gdb = os.path.join(base_path + r'\Data\cities_21\map_WS_21', "map_WS_21.gdb")
    # dem_path = base_path + r'\Data\cities_21\map_DEM_21'

    for i in range(len(cities_en)):
        city_cn = cities_ch[i]
        city_en = cities_en[i]

        # dem = dem_path + '\\' + city_cn + '_DEM.tif'
        # ws = watershed_gdb + '\\' + city_en + '_wsf'
        # dem_max = ZonalStatistics(ws, "OBJECTID", dem, "MAXIMUM", "DATA")
        # dem_min = ZonalStatistics(ws, "OBJECTID", dem, "MINIMUM", "DATA")
        # dem_diff = dem_max - dem_min
        # dem_diff.save(base_path + r'\OutputData\cities_21\\' + city_cn + '\\' + city_en + '_ws_dem_diff.tif')
        #
        # # runoff zonal mean
        # zonal_runoff = ZonalStatistics(ws, "OBJECTID", runoff, "MEAN", "DATA")
        #
        # # inundation = runoff - dem_diff
        # inundation = runoff - dem_diff
        # inundation_binary = Con(inundation > 0, 1, 0)
        # inundation_binary.save(base_path + r'\OutputData\cities_21\\' + city_cn + '\\' + city_en + '_ws_drown_ssp585.tif')

        inundation_binary_path = base_path + r'\OutputData\cities_21\\' + city_cn + '\\' + city_en + '_ws_drown_ssp585.tif'

        inundation_binary_resample_path = base_path + r'\OutputData\cities_21\\' + city_cn + '\\' + city_en + '_ws_drown_ssp585_100m.tif'
        print(arcpy.Describe(Raster(inundation_binary)).meanCellWidth)
        # 降采样
        arcpy.management.Resample(
            in_raster=inundation_binary_path,
            out_raster=inundation_binary_resample_path,
            cell_size=arcpy.Describe(inundation_binary).meanCellWidth/10,
            resampling_type="NEAREST",
        )

        # 每个城市的网格 shp
        grid_shp = base_path + r'\OutputData\cities_21\\' + city_cn + '\\' + city_cn + '_grid.shp'

        # 临时输出表
        out_table = base_path + r'\OutputData\Result_SSP585\cities_21_max\tmp.dbf'

        # 执行 zonal statistics，统计 inundation=1 的比例
        ZonalStatisticsAsTable(in_zone_data=grid_shp,
                               zone_field="Tid",
                               in_value_raster=Raster(inundation_binary_resample_path),
                               out_table=out_table,
                               statistics_type="MAXIMUM",  # 只要有值为1就行
                               ignore_nodata="DATA")

        # 导出CSV（Tid + hazard）
        out_csv = base_path + r'\OutputData\Result_SSP585\cities_21_max\\' + city_cn + '\\' + 'grid_hazard.csv'
        # 写 CSV：Tid + Sum
        with open(out_csv, 'wb') as fout:
            writer = csv.writer(fout)
            writer.writerow(['Tid', 'Hazard'])
            with arcpy.da.SearchCursor(out_table, ["Tid", "MAX"]) as cursor:
                for row in cursor:
                    writer.writerow(row)

        # 清理内存表
        arcpy.Delete_management(out_table)
        print(city_cn)








