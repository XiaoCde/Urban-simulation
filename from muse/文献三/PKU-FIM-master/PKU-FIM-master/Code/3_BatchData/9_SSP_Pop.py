# -*-coding:utf-8 -*-
# python 2.7
# 提取SSP人口

"""
# @File       : 9_SSP_Pop.py
# @software   : PyCharm  
# @Time       ：2025/5/16 17:30
# @Author     ：Wei Lyu
"""

import arcpy
import os
import csv

arcpy.CheckOutExtension("Spatial")
arcpy.env.overwriteOutput = True

from arcpy.sa import *

if __name__ == '__main__':
    # 设置路径
    base_path = "D:/LW/ABM"
    output_path = os.path.join(base_path, "OutputData")
    # pop_raster = os.path.join(base_path, "Data/Pop_SSP/SSP5/SPP5/SSP5_2050_Clip.tif")
    # pop_raster_float = os.path.join(base_path, "Data/Pop_SSP/SSP5/SPP5/SSP5_2050_Clip_float100m.tif")
    # # 将整型人口栅格转换为浮点型
    # if not arcpy.Exists(pop_raster_float):
    #     print("Converting population raster to float...")
    #     float_ras = Float(Raster(pop_raster))
    #     float_ras.save(pop_raster_float)
    #
    # pop_raster = pop_raster_float

    pop_raster = base_path + '/Data/Pop_SSP_v2/SSP5RCP8_5/grid_pop_count2050_SSP5_RCP8_5_float_100m.tif'

    # 读取城市列表
    cities_csv = os.path.join(output_path, "cities_21", "cities21_pop_CH.csv")
    cities = []
    with open(cities_csv, 'rb') as f:
        reader = csv.reader(f)
        for row in reader:
            cities.append(row[0].decode('gbk'))

    # 遍历每个城市
    for city in cities:
        print("Processing city: ", city.encode('gbk'))

        # 路径准备
        grid_shp = os.path.join(output_path, "cities_21", city, city + "_grid.shp")
        out_table = os.path.join(base_path, "OutputData", "Result_SSP585_pop2", "cities_21_max", city, "tmp.dbf")
        out_csv = os.path.join(base_path, "OutputData", "Result_SSP585_pop2", "cities_21_max", city, "grid_population.csv")

        # Zonal Statistics as Table
        ZonalStatisticsAsTable(in_zone_data=grid_shp,
                               zone_field="Tid",
                               in_value_raster=pop_raster,
                               out_table=out_table,
                               statistics_type="MEAN")

        # 写 CSV：Tid + Sum
        with open(out_csv, 'wb') as fout:
            writer = csv.writer(fout)
            writer.writerow(['Tid', 'Con_pop'])
            with arcpy.da.SearchCursor(out_table, ["Tid", "MEAN"]) as cursor:
                for row in cursor:
                    writer.writerow(row)

        # 清理内存表
        arcpy.Delete_management(out_table)




