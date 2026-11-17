# -*-coding:utf-8 -*-
# python 2.7
# 给每个城市的bbox分区统计CBRA，主要是降采样

"""
# @File       : 6_CBRA_city.py
# @software   : PyCharm  
# @Time       ：2024/6/19 22:25
# @Author     ：Wei Lyu
"""
import arcpy
import os
import pandas as pd
import pickle
import time

arcpy.env.parallelProcessingFactor = 0
# 设置环境
arcpy.env.overwriteOutput = True
arcpy.CheckOutExtension("Spatial")

if __name__ == '__main__':
     path = r'D:\LW\ABM\Data'

     CBRA = ['CBRA_2021_1', 'CBRA_2021_2']

     outputPath = r'D:\LW\ABM\OutputData'
     bbox_path = outputPath + '\\' + r'cities_21'

     # 设置降采样因子
     cell_factor = 100  # 替换为降采样因子（例如，将2x2个格子降采样成一个格子）

     files_1 = os.listdir(path + '\\' + CBRA[0])
     files_1 = [file for file in files_1 if file.endswith('.tif')]

     files_2 = os.listdir(path + '\\' + CBRA[1])
     files_2 = [file for file in files_2 if file.endswith('.tif')]

     # 获取每个tif数据的四至
     CBRA_info_1 = {}
     for file in files_1:
         CBRA_each = path + '\\' + CBRA[0] + '\\' + file
         desc = arcpy.Describe(CBRA_each)
         extent = desc.extent
         xmin = extent.XMin
         ymin = extent.YMin
         xmax = extent.XMax
         ymax = extent.YMax
         CBRA_info_1[file[:-4]] = [xmin, xmax, ymin, ymax]

     CBRA_info_2 = {}
     for file in files_2:
         CBRA_each = path + '\\' + CBRA[1] + '\\' + file
         desc = arcpy.Describe(CBRA_each)
         extent = desc.extent
         xmin = extent.XMin
         ymin = extent.YMin
         xmax = extent.XMax
         ymax = extent.YMax
         CBRA_info_2[file[:-4]] = [xmin, xmax, ymin, ymax]

     cities_List = pd.read_csv(r'D:\LW\ABM\OutputData\cities_21' + '\\cities21_pop_CH.csv', header=None)
     cities_cn = cities_List[0].unique().tolist()
     cities_en = cities_List[3].unique().tolist()
     del cities_List

     # 循环每个城市
     # 判断CBRA栅格的四至是否在城市bbox的四至内
     # city_CBRA = {}  # 存储城市对应的栅格名称
     # sum_tif = 0
     # for i in range(len(cities_cn)):
     #     # t0 = time.time()
     #     city_cn = cities_cn[i]
     #     city_en = cities_en[i]
     #     city_CBRA[city_en] = set()
     #     print(cities_en[i])
     #     city_bbox = bbox_path + '\\' + city_cn + '\\' + city_cn + '_bbox.shp'
     #     # 获取四至
     #     desc = arcpy.Describe(city_bbox)
     #     extent = desc.extent
     #     xmin = extent.XMin
     #     ymin = extent.YMin
     #     xmax = extent.XMax
     #     ymax = extent.YMax
     #     xcentroid = (xmin + xmax) / 2
     #     ycentroid = (ymin + ymax) / 2
     #     k = 1
     #     for CBRA_info in [CBRA_info_1, CBRA_info_2]:
     #         for item in CBRA_info.keys():
     #             for i in range(2):
     #                 for j in range(2):
     #                     point_x = CBRA_info[item][i]
     #                     point_y = CBRA_info[item][j+2]
     #                     if xmin <= point_x <= xmax and ymin <= point_y <= ymax:
     #                         city_CBRA[city_en].add('CBRA_2021_' + str(k) + '_res\\' + item + '.tif')
     #             for x in [xmin, xmax]:
     #                 for y in [ymin, ymax]:
     #                     if CBRA_info[item][0] <= x <= CBRA_info[item][1] and CBRA_info[item][2] <= y <= CBRA_info[item][3]:
     #                         city_CBRA[city_en].add('CBRA_2021_' + str(k) + '_res\\' + item + '.tif')
     #             # 可能四至都不在，图像中心在
     #             if CBRA_info[item][0] <= xcentroid <= CBRA_info[item][1] and CBRA_info[item][2] <= ycentroid <= CBRA_info[item][3]:
     #                 city_CBRA[city_en].add('CBRA_2021_' + str(k) + '_res\\' + item + '.tif')
     #         k += 1
     #     sum_tif += len(city_CBRA[city_en])
     #
     # with open(bbox_path + '\\' + 'city_CBRA.pkl', 'wb') as pickle_file:
     #     pickle.dump(city_CBRA, pickle_file)

     with open(bbox_path + '\\' + 'city_CBRA.pkl', 'rb') as pickle_file:
         city_CBRA = pickle.load(pickle_file)

     for city in city_CBRA.keys():
         for file in city_CBRA[city]:
             file_split = file.split('\\')
             file_name = file_split[-1]
             CBRA_conv = outputPath + '\\cities_92\\' + file_split[0][:-4] + '_conv\\' + file_name
             if not arcpy.Exists(CBRA_conv):
                 CBRA_each = path + '//' + file_split[0][:-4] + '\\' + file_split[-1] + '.tif'
                 # 将0替换为0，255替换为1，其他值保持不变
                 converted_raster = arcpy.sa.Con((arcpy.sa.Raster(CBRA_each) == 0) | (arcpy.sa.Raster(CBRA_each) == 255),
                                                 arcpy.sa.Con(arcpy.sa.Raster(CBRA_each) == 0, 0, 1),
                                                 arcpy.sa.Raster(CBRA_each))
                 converted_raster.save(CBRA_conv)
                 print('conv ' + file_split[0][:-4] + ' ' + file_name)
             CBRA_aggre = outputPath + '\\cities_92\\' + file_split[-2] + '\\' + file_name
             if not arcpy.Exists(CBRA_aggre):
                aggregated_raster = arcpy.sa.Aggregate(CBRA_conv, cell_factor, "SUM")
                aggregated_raster.save(CBRA_aggre)
                print('aggre ' + file_split[0][:-4] + ' ' + file_name)

     # mosaic
     for city in city_CBRA.keys():
         files = city_CBRA[city]
         output_raster = bbox_path + '\\map_mos_92.gdb\\' + city + '_mos'
         # 创建目标栅格数据集（如果它不存在）
         if not arcpy.Exists(output_raster):
             arcpy.CreateRasterDataset_management(
                 out_path = bbox_path + '\\map_mos_92.gdb',
                 out_name = city + '_mos',
                 pixel_type = "32_BIT_FLOAT",
                 number_of_bands=1,
                 raster_spatial_reference=arcpy.SpatialReference(4326)
             )
         input_rasters = [bbox_path + '\\' + item for item in files]
         input_rasters = ';'.join(input_rasters)
         print(city, 'Mosaic Begin')
         arcpy.management.Mosaic(
             inputs=input_rasters,
             target=output_raster,
             mosaic_type="LAST",
         )
         ind = cities_en.index(city)
         mask = bbox_path + '\\' + cities_cn[ind] + '\\' + cities_cn[ind] + '_bbox.shp'
         outTable = bbox_path + '\\map_mos_92.gdb\\' + city + '_zonal'
         outZSaT = arcpy.sa.ZonalStatisticsAsTable(mask, "FID", output_raster, outTable, "NODATA", "SUM")


